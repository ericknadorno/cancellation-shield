// nexo — i18n dictionary + runtime.
//
// Loaded BEFORE the main index.html script so `window.nexoI18n` is
// available in the IIFE. Three languages: pt (source), en, de.
//
// Contract:
//   - Keys are dot-notation, grouped by surface (header, kpi, tabs,
//     history, overbooking, model, upload, common, …).
//   - `t(key, params?)` resolves against the current language with
//     automatic fallback to PT if a key is missing, then to the raw
//     key if PT is also missing. Missing PT keys are a bug we want
//     visible in production.
//   - Param interpolation: {name} in the template is replaced with
//     params.name. Objects coerce via String().
//   - Dates/numbers should use t.locale(), which returns the BCP-47
//     tag for toLocaleString / toLocaleDateString. Never hardcode
//     "pt-PT" outside of this file.
//
// Property names (Alegria, Santa Barbara I, Santa Barbara II) are
// intentionally NOT in the dictionary — per the user spec, proper
// nouns and Mews-originating strings (rate names, channels, guest
// names) pass through unmodified.

(function(){
  const DICT = {
    pt: {
      // ─── HEADER ───
      "header.edition": "Ed. {date} · Vol. 1",
      "header.live": "● LIVE",
      "header.allProperties": "Todos",
      "header.refresh": "Atualizar",
      "header.report": "Relatório",

      // ─── STATUS BAR ───
      "status.cache.now": "Dados em cache agora",
      "status.cache.min": "Dados em cache há {n} min",
      "status.cache.hour": "Dados em cache há {h}h {m}min",
      "status.cache.stale": " — considera atualizar",
      "status.cache.clear": "limpar cache",

      // ─── KPIs ───
      "kpi.activeReservations": "Reservas Ativas",
      "kpi.activeReservations.sub": "{n} em risco",
      "kpi.highRisk": "Alto Risco",
      "kpi.highRisk.sub": "{n} médio risco",
      "kpi.revAtRisk": "Receita em Risco",
      "kpi.revAtRisk.sub": "probabilidade ponderada",
      "kpi.overbooking": "Overbooking",
      "kpi.overbooking.sub": "{days} dias · +{rooms} quartos",

      // ─── TABS ───
      "tabs.timeline": "Timeline",
      "tabs.overbooking": "Overbooking",
      "tabs.actions": "Ações",
      "tabs.periods": "Períodos",
      "tabs.history": "Histórico",
      "tabs.model": "Modelo",

      // ─── DATE NAV ───
      "nav.today": "Hoje",
      "nav.days": "{n}d",

      // ─── UPLOAD SCREEN ───
      "upload.hero.title": "nexo",
      "upload.hero.sub": "Protecção inteligente de reservas · edição diária",
      "upload.action.fetch": "Carregar reservas do Mews",
      "upload.action.sheets": "ou carrega um ficheiro Excel",
      "upload.action.clearCache": "Limpar cache e voltar",
      "upload.log.title": "Registo",
      "upload.log.empty": "À espera de acção…",

      // ─── OVERBOOKING ───
      "ob.title": "Overbooking recomendado",
      "ob.col.confidence": "Confiança",
      "ob.col.guest": "Hóspede",
      "ob.col.arrival": "Chegada",
      "ob.col.days": "Dias",
      "ob.col.revAtRisk": "€ em Risco",
      "ob.col.action": "Ação",
      "ob.action.openSale": "Abrir à venda",
      "ob.empty": "Sem recomendações activas para este filtro.",
      "ob.noProp": "Sem dados de overbooking para esta propriedade.",
      "ob.extraRev": "Receita extra",
      "ob.row.index": "#",

      // ─── TIMELINE ───
      "tl.section.guest": "Hóspede",
      "tl.legend.high": "Alto risco",
      "tl.legend.medium": "Médio",
      "tl.legend.low": "Baixo",
      "tl.legend.nrPaid": "NR+Pago",
      "tl.legend.overbooking": "Overbooking",

      // ─── RETENTION / ACTIONS ───
      "ret.title": "Acções recomendadas",
      "ret.col.risk": "Risco",
      "ret.col.guest": "Hóspede",
      "ret.col.arrival": "Chegada",
      "ret.col.offer": "Oferta",
      "ret.col.action": "Ação",
      "ret.addNote": "Adicionar nota",
      "ret.addTask": "Criar tarefa",
      "ret.bulk.notes": "Adicionar todas as notas",
      "ret.bulk.tasks": "Criar todas as tarefas",

      // ─── PERIODS ───
      "periods.title": "Períodos de risco",

      // ─── MODEL ───
      "model.loading": "A carregar métricas…",
      "model.noData": "Sem métricas disponíveis.",
      "model.retrain": "Forçar retreino",
      "model.backfill": "Importar histórico",
      "model.backfilling": "A importar…",
      "model.retraining": "A treinar…",
      "model.active": "Modelo activo",
      "model.metrics.auc": "AUC",
      "model.metrics.brier": "Brier",
      "model.metrics.logloss": "Log-loss",
      "model.metrics.ece": "Erro de calibração",
      "model.metrics.samples": "amostras de treino",
      "model.algo.gbm": "GBM",
      "model.algo.logistic": "Logístico",
      "model.algo.handtuned": "Regras",
      "model.accuracy.title": "Como está a acertar",
      "model.accuracy.accuracy": "Acerto geral",
      "model.accuracy.precision": "Precisão",
      "model.accuracy.recall": "Captura",
      "model.accuracy.sample": "últimas {n} predições",
      "model.retro.title": "Retrospectiva — últimas predições fechadas",
      "model.retro.empty": "Ainda não há predições fechadas para mostrar.",
      "model.features.title": "Factores mais importantes",
      "model.journal.title": "Diário de predições",
      "model.journal.total": "Linhas",
      "model.journal.closed": "Fechadas",
      "model.journal.cancelRate": "Taxa de cancelamento",
      "model.journal.lastSnapshot": "Último snapshot",
      "model.timeline.title": "Evolução — últimos 30 snapshots",

      // ─── HISTORY TAB ───
      "history.loading": "A carregar histórico…",
      "history.empty.cta": "Carregar histórico",
      "history.empty.placeholder": "Ainda não há dados.",
      "history.filter.all": "Todos",
      "history.filter.hit": "Acertos",
      "history.filter.falseAlarm": "Falsos alarmes",
      "history.filter.missed": "Escaparam",
      "history.filter.stayedOk": "OK baixo risco",
      "history.headline.label": "Quando o modelo disse \"vai cancelar\"",
      "history.headline.hitRate": "{pct}% acertou",
      "history.headline.breakdown": "{hits} acertos em {total} alarmes",
      "history.retro.banner": "{retro} retroactivas + {live} live. As retroactivas são reservas antigas re-pontuadas agora com o modelo activo — dizem \"o que o modelo teria dito em {date}\", não o que disse no dia.",
      "history.retro.rowLabel": "Retroactiva — re-pontuada agora",
      "history.retro.detailBanner": "<strong>Retroactiva.</strong> Esta reserva é anterior à ferramenta — o modelo activo foi aplicado agora aos dados históricos. A previsão abaixo é \"o que o modelo diria se tivesse visto esta reserva em {date}\".",
      "history.list.empty": "Nenhuma reserva corresponde ao filtro",
      "history.detail.selectPrompt": "Selecciona uma reserva à esquerda",
      "history.verdict.hit": "ACERTOU",
      "history.verdict.falseAlarm": "FALSO ALARME",
      "history.verdict.missed": "ESCAPOU",
      "history.verdict.stayedOk": "OK",
      "history.detail.hit.title": "Acertou",
      "history.detail.hit.explain": "Previu {pct}% de probabilidade de cancelamento e a reserva {fate}.",
      "history.detail.hit.noShow": "foi no-show",
      "history.detail.hit.cancelled": "foi cancelada",
      "history.detail.falseAlarm.title": "Falso alarme",
      "history.detail.falseAlarm.explain": "Previu {pct}% de probabilidade de cancelamento mas o hóspede apareceu e ficou.",
      "history.detail.missed.title": "Escapou",
      "history.detail.missed.explain": "Previu apenas {pct}% — no limite do MEDIUM — e a reserva {fate}.",
      "history.detail.stayedOk.title": "Baixo risco confirmado",
      "history.detail.stayedOk.explain": "Previu {pct}% de cancelamento e a reserva foi honrada.",
      "history.detail.saidLabel": "O modelo disse",
      "history.detail.saidSub": "prob. de cancelamento · nível {level}",
      "history.detail.actualLabel": "Realmente",
      "history.detail.actual.stayed": "Ficou",
      "history.detail.actual.cancelled": "Cancelou",
      "history.detail.actual.noShow": "Não apareceu",
      "history.detail.actual.on": "em {date}",
      "history.detail.facts.prop": "Propriedade",
      "history.detail.facts.arrival": "Chegada",
      "history.detail.facts.nights": "Noites",
      "history.detail.facts.channel": "Canal",
      "history.detail.facts.rate": "Tarifa",
      "history.detail.facts.adr": "ADR",
      "history.detail.facts.total": "Total",
      "history.detail.facts.leadTime": "Lead time",
      "history.detail.facts.leadTime.value": "{n} dias",
      "history.detail.facts.country": "País",
      "history.detail.factors.title": "Factores que mais pesaram",
      "history.detail.footer.predictedOn": "Previsão feita em {date}",

      // ─── CONFIRMATIONS & PROMPTS ───
      "confirm.retrain": "Forçar retreino do modelo agora?\n\nIsto lê as predições fechadas dos últimos 12 meses, ajusta uma nova regressão logística, e substitui o modelo activo se o AUC melhorar.",

      // ─── ERRORS ───
      "error.prefix": "Erro",
      "error.metricsLoad": "Métricas: {msg}",
      "error.historyLoad": "Histórico: {msg}",
      "error.backfill": "Backfill falhou: {msg}",
      "error.retrain": "Retreino falhou: {msg}",

      // ─── LEVELS ───
      "level.high": "ALTO",
      "level.medium": "MÉDIO",
      "level.low": "BAIXO",

      // ─── COMMON ───
      "common.loading": "A carregar…",
      "common.dash": "—",
      "common.days": "dias",
      "common.rooms": "quartos",
      "common.none": "Nenhum",
      "common.yes": "Sim",
      "common.no": "Não"
    },

    en: {
      "header.edition": "Ed. {date} · Vol. 1",
      "header.live": "● LIVE",
      "header.allProperties": "All",
      "header.refresh": "Refresh",
      "header.report": "Report",

      "status.cache.now": "Data cached just now",
      "status.cache.min": "Data cached {n} min ago",
      "status.cache.hour": "Data cached {h}h {m}min ago",
      "status.cache.stale": " — consider refreshing",
      "status.cache.clear": "clear cache",

      "kpi.activeReservations": "Active Reservations",
      "kpi.activeReservations.sub": "{n} at risk",
      "kpi.highRisk": "High Risk",
      "kpi.highRisk.sub": "{n} medium risk",
      "kpi.revAtRisk": "Revenue at Risk",
      "kpi.revAtRisk.sub": "probability-weighted",
      "kpi.overbooking": "Overbooking",
      "kpi.overbooking.sub": "{days} days · +{rooms} rooms",

      "tabs.timeline": "Timeline",
      "tabs.overbooking": "Overbooking",
      "tabs.actions": "Actions",
      "tabs.periods": "Periods",
      "tabs.history": "History",
      "tabs.model": "Model",

      "nav.today": "Today",
      "nav.days": "{n}d",

      "upload.hero.title": "nexo",
      "upload.hero.sub": "Smart reservation shield · daily edition",
      "upload.action.fetch": "Fetch reservations from Mews",
      "upload.action.sheets": "or upload an Excel file",
      "upload.action.clearCache": "Clear cache and go back",
      "upload.log.title": "Log",
      "upload.log.empty": "Waiting for action…",

      "ob.title": "Recommended overbooking",
      "ob.col.confidence": "Confidence",
      "ob.col.guest": "Guest",
      "ob.col.arrival": "Arrival",
      "ob.col.days": "Days",
      "ob.col.revAtRisk": "€ at Risk",
      "ob.col.action": "Action",
      "ob.action.openSale": "Open for sale",
      "ob.empty": "No recommendations matching this filter.",
      "ob.noProp": "No overbooking data for this property.",
      "ob.extraRev": "Extra revenue",
      "ob.row.index": "#",

      "tl.section.guest": "Guest",
      "tl.legend.high": "High risk",
      "tl.legend.medium": "Medium",
      "tl.legend.low": "Low",
      "tl.legend.nrPaid": "NR+Paid",
      "tl.legend.overbooking": "Overbooking",

      "ret.title": "Recommended actions",
      "ret.col.risk": "Risk",
      "ret.col.guest": "Guest",
      "ret.col.arrival": "Arrival",
      "ret.col.offer": "Offer",
      "ret.col.action": "Action",
      "ret.addNote": "Add note",
      "ret.addTask": "Create task",
      "ret.bulk.notes": "Add all notes",
      "ret.bulk.tasks": "Create all tasks",

      "periods.title": "Risk periods",

      "model.loading": "Loading metrics…",
      "model.noData": "No metrics available.",
      "model.retrain": "Force retrain",
      "model.backfill": "Import history",
      "model.backfilling": "Importing…",
      "model.retraining": "Training…",
      "model.active": "Active model",
      "model.metrics.auc": "AUC",
      "model.metrics.brier": "Brier",
      "model.metrics.logloss": "Log-loss",
      "model.metrics.ece": "Calibration error",
      "model.metrics.samples": "training samples",
      "model.algo.gbm": "GBM",
      "model.algo.logistic": "Logistic",
      "model.algo.handtuned": "Rules",
      "model.accuracy.title": "How well it's calling it",
      "model.accuracy.accuracy": "Overall accuracy",
      "model.accuracy.precision": "Precision",
      "model.accuracy.recall": "Recall",
      "model.accuracy.sample": "last {n} predictions",
      "model.retro.title": "Retrospective — latest closed predictions",
      "model.retro.empty": "No closed predictions to show yet.",
      "model.features.title": "Most important factors",
      "model.journal.title": "Prediction journal",
      "model.journal.total": "Rows",
      "model.journal.closed": "Closed",
      "model.journal.cancelRate": "Cancellation rate",
      "model.journal.lastSnapshot": "Last snapshot",
      "model.timeline.title": "Evolution — last 30 snapshots",

      "history.loading": "Loading history…",
      "history.empty.cta": "Load history",
      "history.empty.placeholder": "No data yet.",
      "history.filter.all": "All",
      "history.filter.hit": "Hits",
      "history.filter.falseAlarm": "False alarms",
      "history.filter.missed": "Missed",
      "history.filter.stayedOk": "OK low risk",
      "history.headline.label": "When the model said \"will cancel\"",
      "history.headline.hitRate": "{pct}% right",
      "history.headline.breakdown": "{hits} hits out of {total} alarms",
      "history.retro.banner": "{retro} retrospective + {live} live. Retrospective rows are old reservations re-scored now with the active model — they say \"what the model would have said on {date}\", not what it said on the day.",
      "history.retro.rowLabel": "Retrospective — re-scored now",
      "history.retro.detailBanner": "<strong>Retrospective.</strong> This reservation predates the tool — the active model was applied just now to historical data. The prediction below is \"what the model would say if it had seen this reservation on {date}\".",
      "history.list.empty": "No reservation matches the filter",
      "history.detail.selectPrompt": "Pick a reservation on the left",
      "history.verdict.hit": "HIT",
      "history.verdict.falseAlarm": "FALSE ALARM",
      "history.verdict.missed": "MISSED",
      "history.verdict.stayedOk": "OK",
      "history.detail.hit.title": "Got it right",
      "history.detail.hit.explain": "Predicted {pct}% probability of cancelling and the reservation {fate}.",
      "history.detail.hit.noShow": "was a no-show",
      "history.detail.hit.cancelled": "was cancelled",
      "history.detail.falseAlarm.title": "False alarm",
      "history.detail.falseAlarm.explain": "Predicted {pct}% probability of cancelling but the guest showed up and stayed.",
      "history.detail.missed.title": "Slipped through",
      "history.detail.missed.explain": "Predicted only {pct}% — right at the MEDIUM threshold — and the reservation {fate}.",
      "history.detail.stayedOk.title": "Low risk confirmed",
      "history.detail.stayedOk.explain": "Predicted {pct}% cancellation and the reservation was honoured.",
      "history.detail.saidLabel": "The model said",
      "history.detail.saidSub": "prob. of cancelling · level {level}",
      "history.detail.actualLabel": "Actually",
      "history.detail.actual.stayed": "Stayed",
      "history.detail.actual.cancelled": "Cancelled",
      "history.detail.actual.noShow": "No-show",
      "history.detail.actual.on": "on {date}",
      "history.detail.facts.prop": "Property",
      "history.detail.facts.arrival": "Arrival",
      "history.detail.facts.nights": "Nights",
      "history.detail.facts.channel": "Channel",
      "history.detail.facts.rate": "Rate",
      "history.detail.facts.adr": "ADR",
      "history.detail.facts.total": "Total",
      "history.detail.facts.leadTime": "Lead time",
      "history.detail.facts.leadTime.value": "{n} days",
      "history.detail.facts.country": "Country",
      "history.detail.factors.title": "Top contributing factors",
      "history.detail.footer.predictedOn": "Prediction made on {date}",

      "confirm.retrain": "Force a model retrain now?\n\nThis reads the closed predictions from the last 12 months, fits a new logistic regression, and replaces the active model if AUC improves.",

      "error.prefix": "Error",
      "error.metricsLoad": "Metrics: {msg}",
      "error.historyLoad": "History: {msg}",
      "error.backfill": "Backfill failed: {msg}",
      "error.retrain": "Retrain failed: {msg}",

      "level.high": "HIGH",
      "level.medium": "MEDIUM",
      "level.low": "LOW",

      "common.loading": "Loading…",
      "common.dash": "—",
      "common.days": "days",
      "common.rooms": "rooms",
      "common.none": "None",
      "common.yes": "Yes",
      "common.no": "No"
    },

    de: {
      "header.edition": "Ausg. {date} · Vol. 1",
      "header.live": "● LIVE",
      "header.allProperties": "Alle",
      "header.refresh": "Aktualisieren",
      "header.report": "Bericht",

      "status.cache.now": "Daten gerade zwischengespeichert",
      "status.cache.min": "Daten vor {n} Min zwischengespeichert",
      "status.cache.hour": "Daten vor {h}h {m}min zwischengespeichert",
      "status.cache.stale": " — bitte aktualisieren",
      "status.cache.clear": "Cache leeren",

      "kpi.activeReservations": "Aktive Reservierungen",
      "kpi.activeReservations.sub": "{n} gefährdet",
      "kpi.highRisk": "Hohes Risiko",
      "kpi.highRisk.sub": "{n} mittleres Risiko",
      "kpi.revAtRisk": "Umsatz in Gefahr",
      "kpi.revAtRisk.sub": "wahrscheinlichkeitsgewichtet",
      "kpi.overbooking": "Überbuchung",
      "kpi.overbooking.sub": "{days} Tage · +{rooms} Zimmer",

      "tabs.timeline": "Zeitleiste",
      "tabs.overbooking": "Überbuchung",
      "tabs.actions": "Aktionen",
      "tabs.periods": "Zeiträume",
      "tabs.history": "Verlauf",
      "tabs.model": "Modell",

      "nav.today": "Heute",
      "nav.days": "{n}T",

      "upload.hero.title": "nexo",
      "upload.hero.sub": "Intelligenter Reservierungsschutz · tägliche Ausgabe",
      "upload.action.fetch": "Reservierungen aus Mews laden",
      "upload.action.sheets": "oder Excel-Datei hochladen",
      "upload.action.clearCache": "Cache leeren und zurück",
      "upload.log.title": "Protokoll",
      "upload.log.empty": "Warten auf Aktion…",

      "ob.title": "Empfohlene Überbuchung",
      "ob.col.confidence": "Vertrauen",
      "ob.col.guest": "Gast",
      "ob.col.arrival": "Ankunft",
      "ob.col.days": "Tage",
      "ob.col.revAtRisk": "€ Risiko",
      "ob.col.action": "Aktion",
      "ob.action.openSale": "Zum Verkauf",
      "ob.empty": "Keine Empfehlungen für diesen Filter.",
      "ob.noProp": "Keine Überbuchungsdaten für diese Unterkunft.",
      "ob.extraRev": "Zusatzumsatz",
      "ob.row.index": "#",

      "tl.section.guest": "Gast",
      "tl.legend.high": "Hohes Risiko",
      "tl.legend.medium": "Mittel",
      "tl.legend.low": "Niedrig",
      "tl.legend.nrPaid": "NR+Bezahlt",
      "tl.legend.overbooking": "Überbuchung",

      "ret.title": "Empfohlene Aktionen",
      "ret.col.risk": "Risiko",
      "ret.col.guest": "Gast",
      "ret.col.arrival": "Ankunft",
      "ret.col.offer": "Angebot",
      "ret.col.action": "Aktion",
      "ret.addNote": "Notiz hinzufügen",
      "ret.addTask": "Aufgabe erstellen",
      "ret.bulk.notes": "Alle Notizen",
      "ret.bulk.tasks": "Alle Aufgaben",

      "periods.title": "Risikozeiträume",

      "model.loading": "Metriken werden geladen…",
      "model.noData": "Keine Metriken verfügbar.",
      "model.retrain": "Training erzwingen",
      "model.backfill": "Historie importieren",
      "model.backfilling": "Importiere…",
      "model.retraining": "Trainiere…",
      "model.active": "Aktives Modell",
      "model.metrics.auc": "AUC",
      "model.metrics.brier": "Brier",
      "model.metrics.logloss": "Log-Loss",
      "model.metrics.ece": "Kalibrierungsfehler",
      "model.metrics.samples": "Trainingsdaten",
      "model.algo.gbm": "GBM",
      "model.algo.logistic": "Logistisch",
      "model.algo.handtuned": "Regeln",
      "model.accuracy.title": "Treffsicherheit",
      "model.accuracy.accuracy": "Gesamttreffer",
      "model.accuracy.precision": "Präzision",
      "model.accuracy.recall": "Erfassung",
      "model.accuracy.sample": "letzte {n} Vorhersagen",
      "model.retro.title": "Rückblick — letzte abgeschlossene Vorhersagen",
      "model.retro.empty": "Noch keine abgeschlossenen Vorhersagen.",
      "model.features.title": "Wichtigste Faktoren",
      "model.journal.title": "Vorhersage-Journal",
      "model.journal.total": "Zeilen",
      "model.journal.closed": "Abgeschlossen",
      "model.journal.cancelRate": "Stornoquote",
      "model.journal.lastSnapshot": "Letzter Snapshot",
      "model.timeline.title": "Entwicklung — letzte 30 Snapshots",

      "history.loading": "Verlauf wird geladen…",
      "history.empty.cta": "Verlauf laden",
      "history.empty.placeholder": "Noch keine Daten.",
      "history.filter.all": "Alle",
      "history.filter.hit": "Treffer",
      "history.filter.falseAlarm": "Fehlalarme",
      "history.filter.missed": "Verpasst",
      "history.filter.stayedOk": "OK niedr. Risiko",
      "history.headline.label": "Wenn das Modell \"wird stornieren\" sagte",
      "history.headline.hitRate": "{pct}% richtig",
      "history.headline.breakdown": "{hits} Treffer bei {total} Alarmen",
      "history.retro.banner": "{retro} rückblickend + {live} live. Rückblickende Zeilen sind alte Reservierungen, die jetzt mit dem aktiven Modell neu bewertet wurden — sie sagen \"was das Modell am {date} gesagt hätte\", nicht was es an jenem Tag sagte.",
      "history.retro.rowLabel": "Rückblickend — gerade neu bewertet",
      "history.retro.detailBanner": "<strong>Rückblickend.</strong> Diese Reservierung ist älter als das Tool — das aktive Modell wurde gerade auf die historischen Daten angewendet. Die Vorhersage unten ist \"was das Modell gesagt hätte, wenn es diese Reservierung am {date} gesehen hätte\".",
      "history.list.empty": "Keine Reservierung passt zum Filter",
      "history.detail.selectPrompt": "Wähle eine Reservierung links aus",
      "history.verdict.hit": "TREFFER",
      "history.verdict.falseAlarm": "FEHLALARM",
      "history.verdict.missed": "VERPASST",
      "history.verdict.stayedOk": "OK",
      "history.detail.hit.title": "Treffer",
      "history.detail.hit.explain": "{pct}% Stornowahrscheinlichkeit vorhergesagt und die Reservierung {fate}.",
      "history.detail.hit.noShow": "war ein No-Show",
      "history.detail.hit.cancelled": "wurde storniert",
      "history.detail.falseAlarm.title": "Fehlalarm",
      "history.detail.falseAlarm.explain": "{pct}% Stornowahrscheinlichkeit vorhergesagt, aber der Gast kam und blieb.",
      "history.detail.missed.title": "Durchgerutscht",
      "history.detail.missed.explain": "Nur {pct}% vorhergesagt — an der MITTEL-Schwelle — und die Reservierung {fate}.",
      "history.detail.stayedOk.title": "Niedriges Risiko bestätigt",
      "history.detail.stayedOk.explain": "{pct}% Stornowahrscheinlichkeit vorhergesagt und die Reservierung wurde eingehalten.",
      "history.detail.saidLabel": "Modell sagte",
      "history.detail.saidSub": "Stornowahrsch. · Stufe {level}",
      "history.detail.actualLabel": "Tatsächlich",
      "history.detail.actual.stayed": "Geblieben",
      "history.detail.actual.cancelled": "Storniert",
      "history.detail.actual.noShow": "Nicht erschienen",
      "history.detail.actual.on": "am {date}",
      "history.detail.facts.prop": "Unterkunft",
      "history.detail.facts.arrival": "Ankunft",
      "history.detail.facts.nights": "Nächte",
      "history.detail.facts.channel": "Kanal",
      "history.detail.facts.rate": "Tarif",
      "history.detail.facts.adr": "ADR",
      "history.detail.facts.total": "Gesamt",
      "history.detail.facts.leadTime": "Vorlaufzeit",
      "history.detail.facts.leadTime.value": "{n} Tage",
      "history.detail.facts.country": "Land",
      "history.detail.factors.title": "Einflussreichste Faktoren",
      "history.detail.footer.predictedOn": "Vorhersage vom {date}",

      "confirm.retrain": "Modelltraining jetzt erzwingen?\n\nDies liest die abgeschlossenen Vorhersagen der letzten 12 Monate, trainiert eine neue logistische Regression und ersetzt das aktive Modell, wenn der AUC sich verbessert.",

      "error.prefix": "Fehler",
      "error.metricsLoad": "Metriken: {msg}",
      "error.historyLoad": "Verlauf: {msg}",
      "error.backfill": "Backfill fehlgeschlagen: {msg}",
      "error.retrain": "Training fehlgeschlagen: {msg}",

      "level.high": "HOCH",
      "level.medium": "MITTEL",
      "level.low": "NIEDRIG",

      "common.loading": "Lade…",
      "common.dash": "—",
      "common.days": "Tage",
      "common.rooms": "Zimmer",
      "common.none": "Keine",
      "common.yes": "Ja",
      "common.no": "Nein"
    }
  };

  const LOCALES = { pt: "pt-PT", en: "en-GB", de: "de-DE" };
  const STORAGE_KEY = "nexo.lang";
  const SUPPORTED = ["pt", "en", "de"];

  // Default resolution order:
  //   1. localStorage (user's explicit choice from a previous session)
  //   2. navigator.language prefix match (pt/en/de)
  //   3. "en" (spec: default to English for anyone not previously set)
  function detectLang() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.includes(saved)) return saved;
    } catch { /* private mode */ }
    const nav = (navigator.language || "").slice(0, 2).toLowerCase();
    if (SUPPORTED.includes(nav)) return nav;
    return "en";
  }

  let current = detectLang();

  function interpolate(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : "{" + k + "}"));
  }

  function t(key, params) {
    const lang = DICT[current] || DICT.en;
    const fallback = DICT.pt;
    const raw = (lang && lang[key]) || (fallback && fallback[key]) || key;
    return interpolate(raw, params);
  }

  function setLang(lang) {
    if (!SUPPORTED.includes(lang) || lang === current) return false;
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private */ }
    try { document.documentElement.lang = lang; } catch {}
    return true;
  }

  function getLang() { return current; }
  function locale() { return LOCALES[current] || "en-GB"; }
  function supported() { return SUPPORTED.slice(); }

  // Reflect initial choice on <html lang="...">
  try { document.documentElement.lang = current; } catch {}

  window.nexoI18n = { t, setLang, getLang, locale, supported };
})();
