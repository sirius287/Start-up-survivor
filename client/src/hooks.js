import { useCallback, useEffect, useRef, useState } from 'react';

/* Hash router: #/ -> landing, #/dashboard, #/admin */
export function useRoute() {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const nav = useCallback((to) => {
    if (window.location.hash === `#${to}`) setRoute(to);
    else window.location.hash = to;
  }, []);
  return [route, nav];
}

/* Poll an async fetcher every `ms`; calls onData(state). Returns { error }. */
export function usePoll(fetcher, onData, ms = 1500, active = true) {
  const [error, setError] = useState(null);
  const cb = useRef(onData);
  cb.current = onData;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = async () => {
      try {
        const data = await fetcher();
        if (alive) {
          setError(null);
          cb.current?.(data);
        }
      } catch (e) {
        if (alive) {
          if (/session|unauthorized|401/i.test(e.message)) {
            window.location.hash = '/';
          } else {
            setError(e.message);
          }
        }
      }
    };
    tick();
    const id = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fetcher, ms, active]);
  return { error };
}

/* Toast stack state */
export function useToasts() {
  const [items, setItems] = useState([]);
  const idRef = useRef(1);
  const push = useCallback((kind, title, msg, duration = 4000) => {
    const id = idRef.current++;
    setItems((prev) => [...prev.slice(-4), { id, kind, title, msg, bye: false }]);
    setTimeout(() => {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, bye: true } : t)));
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 300);
    }, duration);
  }, []);
  return {
    items,
    toast: {
      success: (t, m) => push('green', t, m),
      error: (t, m) => push('red', t, m, 5000),
      warning: (t, m) => push('amber', t, m),
      info: (t, m) => push('', t, m),
      shock: (t, m) => push('amber', t, m, 6000),
    },
  };
}
