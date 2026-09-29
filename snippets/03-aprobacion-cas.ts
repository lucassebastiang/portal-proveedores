// Avance de un flujo de aprobación con «compare-and-swap».
//
// Problema: dos aprobadores pulsan «Aprobar» a la vez sobre el mismo paso, o alguien edita la
// factura mientras el flujo está en marcha.
//
// Solución:
//   - El UPDATE solo afecta a la fila si el paso, el estado y la versión que se leyeron siguen
//     siendo los mismos. Si otro ya decidió, count = 0 y esta decisión no hace nada.
//   - La instancia guarda la «revisión» (updatedAt) de la entidad al empezar. Si la entidad ha
//     cambiado, la aprobación ya no vale: hay que empezar otra sobre los datos actuales.
//   - Quien inicia un flujo no puede aprobarlo.
//   - Los efectos (cambiar el estado de la factura, auditar, encolar el evento) van en la
//     MISMA transacción: o se aplica todo o nada.

type Accion = 'aprobado' | 'rechazado'

interface Instancia {
  id: string
  entidadTipo: 'factura' | 'documento' | 'proveedor'
  entidadId: string
  pasoActual: number
  estado: 'en_curso' | 'aprobado' | 'rechazado' | 'cancelado'
  iniciadaPor: string | null
  revisionEntidad: Date | null
  actualizadaEn: Date
}

export class ConflictoDeAprobacion extends Error {}

export async function decidir(
  db: Db,
  inst: Instancia,
  accion: Accion,
  ultimoPaso: number,
  actorId: string,
  motivo?: string,
): Promise<boolean> {
  if (inst.iniciadaPor === actorId) return false
  if (accion === 'rechazado' && !motivo?.trim()) throw new ConflictoDeAprobacion('Indica el motivo del rechazo.')

  return db.$transaction(async (tx: Db) => {
    const termina = accion === 'rechazado' || inst.pasoActual >= ultimoPaso

    // 1. CAS sobre la instancia.
    const { count } = await tx.instanciaAprobacion.updateMany({
      where: {
        id: inst.id,
        estado: 'en_curso',
        pasoActual: inst.pasoActual,
        actualizadaEn: inst.actualizadaEn,
        OR: [{ iniciadaPor: null }, { iniciadaPor: { not: actorId } }],
      },
      data: termina ? { estado: accion, completadaEn: new Date() } : { pasoActual: { increment: 1 } },
    })
    if (count !== 1) return false // otro ya decidió: no se pisa

    await tx.eventoAprobacion.create({
      data: { instanciaId: inst.id, paso: inst.pasoActual, accion, actorId, comentario: motivo ?? null },
    })

    // 2. Solo al terminar: comprobar que la entidad no ha cambiado y aplicar el efecto.
    if (termina) {
      const entidad = await bloquearEntidad(tx, inst.entidadTipo, inst.entidadId) // SELECT … FOR UPDATE
      if (!inst.revisionEntidad || entidad.actualizadaEn.getTime() !== inst.revisionEntidad.getTime()) {
        throw new ConflictoDeAprobacion('El elemento ha cambiado. Cancela esta aprobación e inicia una nueva.')
      }
      await aplicarEfecto(tx, inst, accion, actorId, motivo) // p. ej. factura → aprobada + histórico
    }
    return true
  })
}

/**
 * Rangos de importe. Un flujo solo encaja si el centro coincide (o es general) y el importe cae en
 * su rango. Si hay flujos OBLIGATORIOS compatibles, la aprobación debe venir de uno de ellos: no
 * se puede esquivar con una revisión manual.
 */
export function flujoEncaja(
  flujo: { centroId: string | null; minimo: number | null; maximo: number | null },
  factura: { centroId: string; total: number; moneda: string },
) {
  if (flujo.centroId && flujo.centroId !== factura.centroId) return false
  if ((flujo.minimo !== null || flujo.maximo !== null) && factura.moneda !== 'EUR') return false
  return (flujo.minimo === null || factura.total >= flujo.minimo) && (flujo.maximo === null || factura.total <= flujo.maximo)
}

type Db = any
declare function bloquearEntidad(tx: Db, tipo: Instancia['entidadTipo'], id: string): Promise<{ actualizadaEn: Date }>
declare function aplicarEfecto(tx: Db, inst: Instancia, accion: Accion, actorId: string, motivo?: string): Promise<void>
