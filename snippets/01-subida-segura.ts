// Subida segura de ficheros a un almacenamiento de objetos PRIVADO.
//
// Orden de defensas (cada una barata antes que la siguiente):
//   1. Límite del cuerpo de la petición y tamaño máximo.
//   2. Tipo real por «magic bytes»: la extensión y el Content-Type los decide el cliente.
//   3. Cupo diario de bytes por proveedor, persistente en PostgreSQL.
//   4. Antivirus autohospedado (clamd, protocolo INSTREAM): nada sale a terceros.
//   5. Clave con UUID: el nombre original nunca forma parte de la ruta.
//   6. Si la transacción de negocio falla, se borra el objeto subido.
// Y al descargar: siempre a través de la aplicación, comprobando permisos y cuarentena.
import { createConnection } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

export class ErrorDeFichero extends Error {
  constructor(mensaje: string, public status: number) { super(mensaje) }
}

// --- 2. Tipo real --------------------------------------------------------------------------------

type Mime = 'application/pdf' | 'image/jpeg' | 'image/png'

export function mimeReal(b: Buffer): Mime | null {
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  return null
}

// --- 3. Cupo diario (UPSERT condicional: atómico entre procesos) ---------------------------------

export async function reservarCupo(db: Db, ambito: string, bytes: number, limite: number) {
  const clave = createHash('sha256').update(ambito).digest('hex')
  const filas = await db.$queryRaw<{ key: string }[]>`
    INSERT INTO cupos_subida (key, bytes, reinicio) VALUES (${clave}, ${bytes}, now() + interval '1 day')
    ON CONFLICT (key) DO UPDATE SET
      bytes    = CASE WHEN cupos_subida.reinicio <= now() THEN ${bytes} ELSE cupos_subida.bytes + ${bytes} END,
      reinicio = CASE WHEN cupos_subida.reinicio <= now() THEN now() + interval '1 day' ELSE cupos_subida.reinicio END
    WHERE cupos_subida.reinicio <= now() OR cupos_subida.bytes + ${bytes} <= ${limite}
    RETURNING key`
  if (filas.length === 0) throw new ErrorDeFichero('Se ha alcanzado el límite diario de subidas.', 429)
}

// --- 4. Antivirus: clamd INSTREAM ----------------------------------------------------------------

let enCurso = 0
const MAX_CONCURRENTES = 4

export async function analizar(cuerpo: Buffer, host: string, puerto = 3310): Promise<void> {
  if (enCurso >= MAX_CONCURRENTES) throw new ErrorDeFichero('El análisis está ocupado. Inténtalo en unos segundos.', 503)
  enCurso++
  try {
    const respuesta = await new Promise<string>((ok, ko) => {
      const s = createConnection({ host, port: puerto })
      let recibido = Buffer.alloc(0)
      let terminado = false
      const fin = (r?: string) => {
        if (terminado) return
        terminado = true; clearTimeout(t); s.destroy()
        r === undefined ? ko(new ErrorDeFichero('No se pudo analizar el archivo.', 503)) : ok(r)
      }
      const t = setTimeout(() => fin(), 30_000)
      s.on('error', () => fin()).on('close', () => fin())
      s.on('data', (c) => {
        recibido = Buffer.concat([recibido, c])
        const nul = recibido.indexOf(0)
        if (nul >= 0) fin(recibido.subarray(0, nul).toString('utf8'))
      })
      s.on('connect', () => {
        s.write('zINSTREAM\0')
        // Trozos de 64 KiB precedidos de su longitud (uint32 big-endian); termina con longitud 0.
        for (let i = 0; i < cuerpo.length; i += 65_536) {
          const trozo = cuerpo.subarray(i, i + 65_536)
          const len = Buffer.alloc(4); len.writeUInt32BE(trozo.length)
          s.write(len); s.write(trozo)
        }
        s.write(Buffer.alloc(4))
      })
    })
    if (respuesta === 'stream: OK') return
    if (respuesta.endsWith(' FOUND')) throw new ErrorDeFichero('El análisis de seguridad ha rechazado el archivo.', 422)
    // Cualquier otra respuesta: no se acepta un fichero sin analizar del todo.
    throw new ErrorDeFichero('El archivo no pudo analizarse por completo.', 503)
  } finally {
    enCurso--
  }
}

// --- 5 y 6. Guardar y registrar ------------------------------------------------------------------

const limpiarNombre = (n: string) =>
  n.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').slice(0, 200) || 'archivo'

export const claveAlmacen = (proveedorId: string, tipo: string, nombre: string) => {
  const d = new Date()
  return `proveedores/${proveedorId}/${tipo}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${randomUUID()}_${limpiarNombre(nombre)}`
}

export async function subirDocumento(ctx: Ctx, proveedorId: string, fichero: File, meta: Meta) {
  const buf = Buffer.from(await fichero.arrayBuffer())
  if (buf.length === 0 || buf.length > 25 * 1024 * 1024) throw new ErrorDeFichero('Tamaño no permitido.', 400)
  const mime = mimeReal(buf)
  if (!mime) throw new ErrorDeFichero('Tipo de archivo no permitido.', 400)

  const clave = claveAlmacen(proveedorId, 'documentos', fichero.name)
  await reservarCupo(ctx.db, `proveedores/${proveedorId}`, buf.length, ctx.cupoDiarioBytes)
  await analizar(buf, ctx.antivirusHost)
  await ctx.db.seguridadFichero.upsert({
    where: { clave },
    create: { clave, veredicto: 'limpio', sha256: createHash('sha256').update(buf).digest('hex') },
    update: { veredicto: 'limpio', analizadoEn: new Date() },
  })
  await ctx.s3.put(clave, buf, mime)

  try {
    return await ctx.db.$transaction(async (tx) => {
      const doc = await tx.documento.create({ data: { proveedorId, clave, mime, ...meta, estado: 'pendiente_revision' } })
      await tx.auditoria.create({ data: { accion: 'documento.subido', entidadId: doc.id } })
      await encolarEvento(tx, 'documento.subido', { documentoId: doc.id, proveedorId }) // ver 04
      return doc
    })
  } catch (e) {
    await ctx.s3.delete(clave).catch(() => {}) // sin fila, el objeto sería huérfano
    throw e
  }
}

// --- Descarga: siempre por la aplicación ---------------------------------------------------------

export async function descargar(ctx: Ctx, clave: string, nombre: string, mime: string): Promise<Response> {
  // (Los permisos por centro y cuenta ya se han comprobado antes de llegar aquí.)
  const seguridad = await ctx.db.seguridadFichero.findUnique({ where: { clave } })
  if (seguridad && seguridad.veredicto !== 'limpio') {
    return Response.json({ error: 'El archivo está en cuarentena.' }, { status: 423 })
  }
  const flujo: Readable = await ctx.s3.get(clave)
  return new Response(flujo as unknown as ReadableStream, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(nombre)}`,
      'Cache-Control': 'private, no-store',
    },
  })
}

// Tipos mínimos para que el ejemplo se lea.
type Db = any
interface Ctx {
  db: Db
  s3: { put(k: string, b: Buffer, m: string): Promise<void>; get(k: string): Promise<Readable>; delete(k: string): Promise<void> }
  antivirusHost: string
  cupoDiarioBytes: number
}
interface Meta { tipoDocumentoId: string; centroId: string | null; caducidad: Date | null }
declare function encolarEvento(tx: Db, evento: string, datos: object): Promise<void>
