// ShapesOS — Fase 19A (WS=server): textos en español de Ajustes → Tú →
// Cursor (el cursor de voz de ShapesOS Desktop).

export const cursorEs = {
  cursor: {
    title: "Cursor",
    subtitle: "El cursor de voz de ShapesOS Desktop: mantén pulsada una tecla, habla y te señala dónde hacer clic.",
    voice: {
      title: "Voz",
      help: "La voz con la que responde el cursor. La lista viene del servicio de voz que usa este servidor.",
      label: "Voz del cursor",
      default: "Voz predeterminada",
      loading: "Cargando voces",
      saved: "Voz guardada",
      saveFailed: "No se pudo guardar la voz",
      notConfigured: "Las respuestas habladas aún no están configuradas en este servidor. El cursor muestra sus respuestas como texto.",
      listFailed: "No se pudo leer la lista de voces. Vuelve a intentarlo en un momento.",
      mock: "Voz de prueba (silenciosa): este servidor usa proveedores de prueba.",
      provider: "Servicio de voz: {name}",
    },
    talk: {
      title: "Minutos de voz",
      help: "Cuenta cada minuto empezado en que mantienes pulsada la tecla para hablar. Los minutos que superan los incluidos en tu plan usan créditos.",
      used: "{used, plural, one {# minuto usado} other {# minutos usados}} este mes",
      included: "{included, plural, one {# minuto incluido} other {# minutos incluidos}}",
      unlimited: "Ilimitados en un servidor propio",
      usage: "Ver créditos en Uso",
    },
    providers: {
      title: "Qué usa el cursor",
      speechIn: "Voz a texto",
      speechOut: "Texto a voz",
      brain: "Ver y responder",
      ready: "Listo",
      notSet: "Sin configurar",
      test: "Proveedor de prueba",
    },
    desktop: {
      title: "ShapesOS Desktop",
      body: "El cursor vive en la app de escritorio para Mac y Windows. Solo ve tu pantalla mientras mantienes pulsada la tecla para hablar y nunca guarda capturas.",
      download: "Descargar ShapesOS Desktop",
    },
    safety: "Las acciones con dinero o irreversibles nunca se aprueban por voz: haces clic en Aprobar en la tarjeta.",
  },
} as const;
