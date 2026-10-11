import { createContext, useContext, useEffect, useRef } from 'react';

const Ctx = createContext(null);

// Un solo EventSource per tutta l'app. Gli eventi `job` arrivano ai listener registrati; a ogni
// (ri)connessione vengono avvisati anche i listener di riconnessione, così i pannelli possono riallinearsi.
export function EventsProvider({ children }) {
  const value = useRef({ listeners: new Set(), reconnects: new Set() });
  useEffect(() => {
    const { listeners, reconnects } = value.current;
    let es = null;
    let timer = null;
    let delay = 1000;
    let stopped = false;
    function connect() {
      es = new EventSource('/api/events');
      es.addEventListener('job', (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        for (const fn of [...listeners]) fn(data);
      });
      // Ogni `open` (anche il primo e quelli dopo una caduta) può aver lasciato buchi: i pannelli si riallineano.
      es.onopen = () => {
        delay = 1000;
        for (const fn of [...reconnects]) fn();
      };
      // Se il browser si riconnette da solo (CONNECTING) non si fa nulla; se il flusso è CLOSED (es. 401 dopo il riavvio
      // del server) il browser non riprova più: ricreiamo l'EventSource con backoff esponenziale fino a 30 s.
      es.onerror = () => {
        if (stopped || es.readyState !== 2) return;
        es.close();
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    }
    connect();
    return () => { stopped = true; clearTimeout(timer); es?.close(); };
  }, []);
  return <Ctx.Provider value={value.current}>{children}</Ctx.Provider>;
}

// onEvent: eventi `job` di quel jobId. onReconnect (opzionale): chiamato a ogni apertura/riapertura del flusso SSE.
export function useJobEvents(jobId, onEvent, onReconnect) {
  const ctx = useContext(Ctx);
  const cb = useRef(onEvent);
  const rc = useRef(onReconnect);
  cb.current = onEvent;
  rc.current = onReconnect;
  useEffect(() => {
    if (!ctx || !jobId) return undefined;
    const fn = (e) => { if (e.jobId === jobId) cb.current(e); };
    const re = () => rc.current?.();
    ctx.listeners.add(fn);
    ctx.reconnects.add(re);
    return () => { ctx.listeners.delete(fn); ctx.reconnects.delete(re); };
  }, [ctx, jobId]);
}

// Tutti gli eventi `job` (di qualunque job): per indicatori globali come il banner delle domande in sospeso.
// onReconnect (opzionale): a ogni apertura/riapertura del flusso SSE.
export function useAnyJobEvent(onEvent, onReconnect) {
  const ctx = useContext(Ctx);
  const cb = useRef(onEvent);
  const rc = useRef(onReconnect);
  cb.current = onEvent;
  rc.current = onReconnect;
  useEffect(() => {
    if (!ctx) return undefined;
    const fn = (e) => cb.current(e);
    const re = () => rc.current?.();
    ctx.listeners.add(fn);
    ctx.reconnects.add(re);
    return () => { ctx.listeners.delete(fn); ctx.reconnects.delete(re); };
  }, [ctx]);
}
