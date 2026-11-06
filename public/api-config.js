window.RICE_API_URL = "http://localhost:3000";
(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
        let user = null;
        try { user = JSON.parse(localStorage.getItem('rice_user') || 'null'); } catch {}
        const token = user?.token;
        if (!token) return originalFetch(input, init);
        const requestUrl = typeof input === 'string' ? new URL(input, window.location.href) : new URL(input.url, window.location.href);
        const apiOrigin = window.RICE_API_URL ? new URL(window.RICE_API_URL, window.location.href).origin : window.location.origin;
        if (requestUrl.origin !== apiOrigin) return originalFetch(input, init);
        const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
        headers.set('Authorization', 'Bearer ' + token);
        return originalFetch(input, { ...init, headers });
    };
})();
