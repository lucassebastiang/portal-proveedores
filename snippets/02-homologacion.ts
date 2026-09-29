// Homologación de proveedores por nivel de riesgo.
//
// Principios:
//   - UNA sola función evalúa el expediente. La usan la pantalla, las acciones de administración,
//     los flujos de aprobación y las acciones que llegan desde n8n: ninguna vía se la salta.
//   - Se evalúa POR CENTRO: un documento puede valer para todos o solo para uno.
//   - Las reglas adicionales (por centro, actividad o nivel) SUMAN requisitos; nunca quitan.
//   - Solo cuenta lo aprobado, vigente y no sustituido por una versión más nueva.

export type Nivel = 1 | 2 | 3 | 4

// Códigos genéricos de ejemplo.
const DOCUMENTOS_POR_NIVEL: Record<Nivel, string[]> = {
  1: ['identificacion_fiscal', 'datos_bancarios'],
  2: ['identificacion_fiscal', 'datos_bancarios', 'seguro_rc', 'formacion_prevencion'],
  3: ['identificacion_fiscal', 'datos_bancarios', 'seguro_rc', 'formacion_prevencion', 'autorizaciones', 'fichas_tecnicas'],
  4: ['identificacion_fiscal', 'datos_bancarios', 'seguro_rc', 'formacion_prevencion', 'autorizaciones', 'fichas_tecnicas', 'plan_continuidad'],
}
const FIRMAS_POR_NIVEL: Record<Nivel, string[]> = {
  1: ['evaluacion_periodica'],
  2: ['evaluacion_periodica', 'confidencialidad', 'normas_acceso'],
  3: ['evaluacion_periodica', 'confidencialidad', 'normas_acceso', 'proteccion_datos', 'plan_contingencia'],
  4: ['evaluacion_periodica', 'confidencialidad', 'normas_acceso', 'proteccion_datos', 'plan_contingencia', 'penalizaciones'],
}
/** Firmas que caducan y hay que renovar. */
const FIRMAS_PERIODICAS = new Set(['evaluacion_periodica'])
const mesesDeRevision = (n: Nivel) => (n === 4 ? 6 : 12)

export interface Documento {
  codigoTipo: string
  centroId: string | null // null = vale para todos los centros
  estado: 'pendiente_revision' | 'aprobado' | 'rechazado' | 'caducado'
  caducidad: Date | null
  sustituido: boolean
}
export interface Firma {
  requisito: string
  centroId: string | null
  estado: 'enviada' | 'completada' | 'rechazada' | 'caducada'
  completadaEn: Date | null
  tieneDocumentoFirmado: boolean
}
export interface Regla {
  tipo: 'documento' | 'firma'
  codigo: string
  centroId: string | null
  nivel: Nivel | null
  actividad: string | null
}
export interface Expediente {
  nivel: Nivel | null
  actividad: string
  responsableActivo: boolean
  centrosActivos: { id: string; nombre: string }[]
  documentos: Documento[]
  firmas: Firma[]
  aprobacionesAbiertasORechazadas: boolean
}

export function evaluar(exp: Expediente, reglas: Regla[], ahora = new Date()): string[] {
  const fallos: string[] = []
  if (!exp.nivel) return ['Falta clasificar el nivel de riesgo.']
  if (!exp.responsableActivo) fallos.push('Falta un responsable interno activo.')
  if (exp.centrosActivos.length === 0) fallos.push('Falta un centro activo vinculado.')
  if (exp.aprobacionesAbiertasORechazadas) fallos.push('Hay aprobaciones pendientes o rechazadas.')

  const nivel = exp.nivel
  const aplicables = reglas.filter(
    (r) => (r.nivel === null || r.nivel === nivel) && (r.actividad === null || r.actividad === exp.actividad),
  )
  const msRevision = mesesDeRevision(nivel) * 30.44 * 86_400_000

  for (const centro of exp.centrosActivos) {
    const extra = (tipo: Regla['tipo']) =>
      aplicables.filter((r) => r.tipo === tipo && (r.centroId === null || r.centroId === centro.id)).map((r) => r.codigo)

    const docsExigidos = new Set([...DOCUMENTOS_POR_NIVEL[nivel], ...extra('documento')])
    for (const codigo of docsExigidos) {
      const ok = exp.documentos.some(
        (d) =>
          d.codigoTipo === codigo &&
          (d.centroId === null || d.centroId === centro.id) &&
          d.estado === 'aprobado' &&
          !d.sustituido &&
          (!d.caducidad || d.caducidad >= ahora),
      )
      if (!ok) fallos.push(`${centro.nombre}: documento «${codigo}» pendiente o caducado.`)
    }

    const firmasExigidas = new Set([...FIRMAS_POR_NIVEL[nivel], ...extra('firma')])
    for (const codigo of firmasExigidas) {
      const ok = exp.firmas.some(
        (f) =>
          f.requisito === codigo &&
          (f.centroId === null || f.centroId === centro.id) &&
          f.estado === 'completada' &&
          f.tieneDocumentoFirmado &&
          !!f.completadaEn &&
          (!FIRMAS_PERIODICAS.has(codigo) || f.completadaEn.getTime() + msRevision > ahora.getTime()),
      )
      if (!ok) fallos.push(`${centro.nombre}: firma «${codigo}» pendiente o caducada.`)
    }
  }
  return fallos
}

/**
 * Activar un proveedor. Se llama DENTRO de la transacción, con la fila del proveedor bloqueada
 * (SELECT … FOR UPDATE) y con los datos ya aplicados: si la clasificación nueva no se cumple, la
 * excepción revierte todo, sin auditoría ni evento de éxito.
 */
export function comprobarActivacion(exp: Expediente, reglas: Regla[]): void {
  const fallos = evaluar(exp, reglas)
  if (fallos.length) {
    const resumen = fallos.slice(0, 5).join(' ')
    throw new Error(`No se puede homologar: ${resumen}${fallos.length > 5 ? ` Y ${fallos.length - 5} requisitos más.` : ''}`)
  }
}
