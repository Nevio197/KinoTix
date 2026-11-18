var initializeTransport = Module.onRuntimeInitialized;
Module.onRuntimeInitialized = function () {
    if (initializeTransport) initializeTransport();
    self.addEventListener('message', function (event) {
        var request = event.data;
        if (request.type !== 'kinotix-request') return;
        Module.ccall('net_fetch', null, ['number', 'string', 'string', 'string', 'string', 'string', 'number', 'number'],
            [request.id, request.url, request.address || '', request.method,
             request.headers || '', request.body || '', request.maxBytes, request.responseType === 'bytes' ? 1 : 0]);
    });
    postMessage({ type: 'kinotix-transport-ready' });
};
