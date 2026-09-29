// Cola durable de entregas (patrón «transactional outbox») para webhooks hacia n8n y correos.
//
// - Encolar va DENTRO de la transacción de negocio: si esta falla, no sale nada; si se
//   confirma, el evento no se puede perder.
// - La carga se guarda cifrada (AES-256-GCM) y se borra al entregarse.
// - Un procesador reserva trabajos de uno en uno con FOR UPDATE SKIP LOCKED y un «lease»: varias
//   instancias no se pisan, y un proceso que muere libera su trabajo al vencer el lease.
// - Entrega firmada con HMAC, con identificador de entrega e Idempotency-Key.
// - Fallos permanentes (4xx) frente a transitorios (5xx, 408, 429, red), con backoff.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

type Carga = { canal: 'webhook'; destino: string; evento: string; cuerpo: string }

// --- Cifrado de la carga --------------------------------------------------------------------------

const clave = () => createHash('sha256').update('entregas-v1\0' + process.env.SECRETO_APP!).digest()

export function sellar(c: Carga): string {
  const iv = randomBytes(12)
  const cif = createCipheriv('aes-256-gcm', clave(), iv)
  const datos = Buffer.concat([cif.update(JSON.stringify(c), 'utf8'), cif.final()])
  return ['v1', iv, cif.getAuthTag(), datos].map((x) => (typeof x === 'string' ? x : x.toString('base64'))).join('.')
}

export function abrir(s: string): Carga {
  const [v, iv, tag, datos] = s.split('.')
  if (v !== 'v1' || !iv || !tag || !datos) throw new Error('CARGA_NO_VALIDA')
  const d = createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8'))
}

// --- Encolar (dentro de la transacción de negocio) --------------------------------------------

export async function encolarEvento(tx: Db, evento: string, datos: object, dedupe = randomUUID()) {
  const destino = process.env.WEBHOOK_URL
  if (!destino) return // integración desactivada: no acumular eventos sin destino
  const cuerpo = JSON.stringify({ ...datos, evento, momento: new Date().toISOString() })
  await tx.trabajoEntrega.createMany({
    data: [{
      clave: createHash('sha256').update('webhook:' + dedupe).digest('hex'),
      carga: sellar({ canal: 'webhook', destino, evento, cuerpo }),
      caduca: new Date(Date.now() + 48 * 3_600_000),
    }],
    skipDuplicates: true, // una clave repetida no aborta la transacción
  })
}

// --- Procesador -----------------------------------------------------------------------------------

const MAX_INTENTOS = 8
const LEASE_MS = 120_000
const ESPERAS = [30e3, 60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 4 * 3600e3, 12 * 3600e3]

class Fallo extends Error {
  constructor(public codigo: string, public permanente = false) { super(codigo) }
}

async function reservar(db: Db) {
  const token = randomUUID()
  return db.$transaction(async (tx: Db) => {
    const [fila] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM trabajos_entrega
       WHERE (estado = 'pendiente' AND disponible <= now())
          OR (estado = 'procesando' AND lease_hasta <= now())
       ORDER BY disponible, creado
       LIMIT 1 FOR UPDATE SKIP LOCKED`
    if (!fila) return null
    return tx.trabajoEntrega.update({
      where: { id: fila.id },
      data: { estado: 'procesando', token, leaseHasta: new Date(Date.now() + LEASE_MS), intentos: { increment: 1 } },
    })
  })
}

async function entregar(trabajo: Trabajo, c: Carga) {
  if (c.destino !== process.env.WEBHOOK_URL) throw new Fallo('DESTINO_CAMBIADO', true)
  const secreto = process.env.WEBHOOK_SECRETO
  if (!secreto) throw new Fallo('SIN_SECRETO')
  const r = await fetch(c.destino, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'Content-Type': 'application/json',
      'X-Firma': createHmac('sha256', secreto).update(c.cuerpo).digest('hex'),
      'X-Evento': c.evento,
      'X-Entrega-Id': trabajo.id,
      'Idempotency-Key': trabajo.id,
    },
    body: c.cuerpo,
  })
  await r.body?.cancel() // no se lee ni se registra la respuesta: puede ser enorme o sensible
  if (!r.ok) {
    const permanente = r.status >= 300 && r.status < 500 && ![408, 429].includes(r.status)
    throw new Fallo(`HTTP_${r.status}`, permanente)
  }
}

export async function procesarUno(db: Db): Promise<boolean> {
  const t: Trabajo | null = await reservar(db)
  if (!t) return false
  let fallo: Fallo | null = null
  try {
    if (t.intentos > MAX_INTENTOS || t.caduca <= new Date()) throw new Fallo('CADUCADO', true)
    await entregar(t, abrir(t.carga!))
  } catch (e) {
    fallo = e instanceof Fallo ? e : new Fallo('NO_DISPONIBLE')
  }
  const final = !!fallo && (fallo.permanente || t.intentos >= MAX_INTENTOS)
  // Solo quien tiene el token de la reserva puede cerrar el trabajo: un proceso antiguo no pisa
  // el resultado de una reserva nueva.
  await db.trabajoEntrega.updateMany({
    where: { id: t.id, estado: 'procesando', token: t.token },
    data: fallo
      ? {
          estado: final ? 'fallido' : 'pendiente',
          ultimoError: fallo.codigo,
          token: null,
          leaseHasta: null,
          disponible: new Date(Date.now() + ESPERAS[Math.min(t.intentos - 1, ESPERAS.length - 1)]),
        }
      : { estado: 'entregado', carga: null, entregadoEn: new Date(), token: null, leaseHasta: null },
  })
  return true
}

type Db = any
interface Trabajo { id: string; token: string; intentos: number; caduca: Date; carga: string | null }
