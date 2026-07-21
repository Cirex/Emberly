/** Today board copy. OWNED by the Today feature agent — grow it here. */
const en = {
  today: {
    title: "Today",
    metrics: {
      occupancy: "Occupancy",
      occupancyCaption: "{{occupied}} of {{total}} units",
      balances: "Balances owed",
      balancesCaption: "{{count}} units owing",
      moveIns30: "Move-ins 30d",
      expiring60: "Expiring 60d",
      expiring60Caption: "{{amount}} at risk",
    },
    flow: {
      title: "Today's flow",
      go: "Leasing",
      empty: "No leasing activity in the last two weeks.",
    },
    feed: {
      moveIn: "{{who}} moved in",
      application: "Application for {{unit}}",
      signed: "{{who}} signed",
      moveOutScheduled: "Move-out · {{unit}} · effective {{date}}",
      movedOut: "{{who}} moved out",
    },
    time: {
      today: "Today",
      yesterday: "Yesterday",
      daysAgo: "{{count}}d ago",
      inDays: "in {{count}}d",
    },
    flowChart: {
      title: "Move-in / move-out flow",
      caption: "6 months",
      moveIns: "Move-ins",
      moveOuts: "Move-outs",
    },
    runway: {
      title: "Leasing runway",
      caption: "Next 60 days",
      go: "Leasing",
      expiring: "{{count}} leases expiring in 60 days",
      atRisk: "{{amount}} rent at risk",
      markToMarket: "mark-to-market {{amount}}",
      applicants: "{{count}} applicants · {{approved}} approved · {{screening}} screening",
      renewedPill: "{{count}} renewed",
      noResponsePill: "{{count}} no response",
      leaseSentPill: "{{count}} lease sent",
    },
    expiringSoon: {
      title: "Expiring soon",
      renewed: "renewed",
      notice: "notice",
    },
  },
};

/** Spanish catalog — mirrors `en` key-for-key. */
const es: typeof en = {
  today: {
    title: "Hoy",
    metrics: {
      occupancy: "Ocupación",
      occupancyCaption: "{{occupied}} de {{total}} unidades",
      balances: "Saldos por cobrar",
      balancesCaption: "{{count}} unidades con saldo",
      moveIns30: "Entradas 30d",
      expiring60: "Vencen 60d",
      expiring60Caption: "{{amount}} en riesgo",
    },
    flow: {
      title: "El flujo de hoy",
      go: "Arrendamiento",
      empty: "Sin actividad de arrendamiento en las últimas dos semanas.",
    },
    feed: {
      moveIn: "{{who}} entró",
      application: "Solicitud para {{unit}}",
      signed: "{{who}} firmó",
      moveOutScheduled: "Salida · {{unit}} · efectiva {{date}}",
      movedOut: "{{who}} se mudó",
    },
    time: {
      today: "Hoy",
      yesterday: "Ayer",
      daysAgo: "hace {{count}}d",
      inDays: "en {{count}}d",
    },
    flowChart: {
      title: "Flujo de entradas y salidas",
      caption: "6 meses",
      moveIns: "Entradas",
      moveOuts: "Salidas",
    },
    runway: {
      title: "Pista de arrendamiento",
      caption: "Próximos 60 días",
      go: "Arrendamiento",
      expiring: "{{count}} contratos vencen en 60 días",
      atRisk: "{{amount}} de renta en riesgo",
      markToMarket: "contra mercado {{amount}}",
      applicants: "{{count}} solicitantes · {{approved}} aprobados · {{screening}} en revisión",
      renewedPill: "{{count}} renovados",
      noResponsePill: "{{count}} sin respuesta",
      leaseSentPill: "{{count}} contratos enviados",
    },
    expiringSoon: {
      title: "Vencen pronto",
      renewed: "renovado",
      notice: "aviso",
    },
  },
};

export const today = { en, es };
