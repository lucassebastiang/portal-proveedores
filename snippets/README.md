# Fragmentos de código

Reescritos a partir del proyecto para ilustrar las ideas. Están **simplificados y son genéricos**: no son el código de producción ni compilan como proyecto por sí solos. Se usa Prisma como cliente de base de datos.

| Fichero | Qué muestra |
|---|---|
| [01-subida-segura.ts](01-subida-segura.ts) | *Magic bytes*, cupo diario, antivirus por INSTREAM, clave con UUID, limpieza si la transacción falla y descarga por *streaming* con cuarentena |
| [02-homologacion.ts](02-homologacion.ts) | Requisitos por nivel de riesgo, evaluación por centro y bloqueo de la activación |
| [03-aprobacion-cas.ts](03-aprobacion-cas.ts) | Avance de un flujo de aprobación con *compare-and-swap* y comprobación de la revisión |
| [04-cola-entregas.ts](04-cola-entregas.ts) | *Transactional outbox*: encolar en la transacción, reservar con `SKIP LOCKED`, entregar con HMAC y reintentar con *backoff* |
