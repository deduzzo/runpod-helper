import { createContext, useContext, useEffect, useRef } from 'react';

const Ctx = createContext(null);

// Un solo EventSource per tutta l'app. Gli eventi `job` arrivano ai listener registrati; a ogni
// (ri)connessione vengono avvisati anche i listener di riconnessione, così i pannelli possono riallinearsi.
export function EventsProvider({ children }) {
  const value = useRef({ listeners: new Set(), reconnects: new Set() });
  useEffect(() => {
    const { listeners, reconnects } = value.current;
    const es = new EventSource('/api/events');
    es.addEventListener('job', (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      for (const fn of [...listeners]) fn(data);
    });
    // EventSource si riconnette da solo: ogni `open` dopo una caduta può aver perso eventi.
    es.onopen = () => { for (const fn of [...reconnects]) fn(); };
    return () => es.close();
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
