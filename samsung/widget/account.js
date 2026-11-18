(function (global) {
  'use strict';

  var PAIRING = '/functions/v1/kinotix-tv-auth';
  var VAULT = 'kinotix-samsung-account-v1-';
  var SLOTS = [VAULT + 'a', VAULT + 'b'];
  var MAX_BYTES = 4 * 1024 * 1024;
  var uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  var tokenPattern = /^[A-Za-z0-9._~-]{8,16384}$/;

  function failure(message, status) {
    var error = new Error(message);
    if (status) error.status = status;
    return error;
  }

  function validIdentity(value) {
    return value && uuid.test(value.id) && typeof value.email === 'string' &&
      value.email.length <= 320 && value.email.indexOf('@') > 0 && !/[\x00-\x1f\x7f]/.test(value.email);
  }

  function configValue(value) {
    try {
      var url = new URL(value.url);
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
          url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
          typeof value.publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(value.publishableKey)) return null;
      return {origin: url.origin, host: url.hostname, key: value.publishableKey};
    } catch (_) { return null; }
  }

  function loadConfiguration() {
    return new Promise(function (resolve) {
      var request = new XMLHttpRequest();
      request.open('GET', 'supabase.json', true);
      request.timeout = 5000;
      request.onload = function () {
        if ((request.status !== 0 && request.status !== 200) || request.responseText.length > 8192) {
          resolve(null);
          return;
        }
        try { resolve(configValue(JSON.parse(request.responseText))); }
        catch (_) { resolve(null); }
      };
      request.onerror = request.ontimeout = function () { resolve(null); };
      request.send();
    });
  }

  function keymanager() {
    var store = global.tizen && global.tizen.keymanager;
    if (!store || typeof store.getData !== 'function' || typeof store.saveData !== 'function' ||
        typeof store.removeData !== 'function') {
      throw failure('Der geschützte Kontospeicher ist auf diesem Fernseher nicht verfügbar.');
    }
    return store;
  }

  function removeSlot(store, name) {
    try { store.removeData({name: name}); }
    catch (error) { if (!error || error.name !== 'NotFoundError') throw error; }
  }

  function readSlot(store, name) {
    var raw;
    try { raw = store.getData({name: name}); }
    catch (error) {
      if (error && error.name === 'NotFoundError') return null;
      throw failure('Die gespeicherte Anmeldung konnte nicht geöffnet werden.');
    }
    try {
      if (typeof raw !== 'string' || raw.length > 32768) return null;
      var saved = JSON.parse(raw);
      if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 1 ||
          !validIdentity(saved.owner) || typeof saved.refresh !== 'string' || !tokenPattern.test(saved.refresh) ||
          typeof saved.origin !== 'string') return null;
      return {name: name, value: saved};
    } catch (_) { return null; }
  }

  function vaultEntries(store) {
    return SLOTS.map(function (name) { return readSlot(store, name); }).filter(Boolean)
      .sort(function (a, b) { return b.value.revision - a.value.revision; });
  }

  function nativeSave(store, name, value) {
    return new Promise(function (resolve, reject) {
      try {
        store.saveData(name, JSON.stringify(value), null, resolve, function () {
          reject(failure('Die Anmeldung konnte nicht im geschützten Speicher gesichert werden.'));
        });
      } catch (_) { reject(failure('Die Anmeldung konnte nicht im geschützten Speicher gesichert werden.')); }
    });
  }

  function randomToken() {
    if (!global.crypto || !global.crypto.getRandomValues || !global.crypto.subtle) {
      throw failure('Die geschützte Google-Anmeldung wird auf diesem Fernseher nicht unterstützt.');
    }
    var bytes = new Uint8Array(32);
    global.crypto.getRandomValues(bytes);
    return base64URL(bytes);
  }

  function base64URL(bytes) {
    var text = '';
    for (var index = 0; index < bytes.length; index++) text += String.fromCharCode(bytes[index]);
    return global.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function digest(value) {
    var input = new Uint8Array(value.length);
    for (var index = 0; index < value.length; index++) input[index] = value.charCodeAt(index);
    return global.crypto.subtle.digest('SHA-256', input).then(function (result) {
      return base64URL(new Uint8Array(result));
    });
  }

  function create(callbacks) {
    callbacks = callbacks || {};
    var config, owner, session, pairing, candidate;
    var generation = 0, vaultWork = Promise.resolve();
    var startFlight, beginFlight, pollFlight, confirmFlight, refreshFlight, syncFlight, signOutFlight;
    var timer, initialized = false;
    var state = {configured: false, connected: false, restoring: false, signingIn: false,
      awaitingConfirmation: false, signingOut: false, email: '', message: '', lastSync: null, qrUrl: '', expiresAt: null};

    function status() { return Object.assign({}, state); }
    function update(values) {
      Object.assign(state, values);
      if (callbacks.onChange) callbacks.onChange(status());
    }
    function ensureCurrent(attempt) {
      if (attempt !== generation) throw failure('Der Anmeldeversuch wurde beendet.');
    }
    function requirePairing(attempt, current) {
      ensureCurrent(attempt);
      if (!current || current !== pairing || current.expiresAt <= Date.now()) {
        cancelSignIn();
        throw failure('Die Anmeldung ist abgelaufen. Starte sie erneut.');
      }
    }
    function serializedVault(operation) {
      var result = vaultWork.then(operation);
      vaultWork = result.catch(function () {});
      return result;
    }
    function saveSession(value, attempt, expiresAt) {
      return serializedVault(async function () {
        ensureCurrent(attempt);
        if (expiresAt && expiresAt <= Date.now()) throw failure('Die Anmeldung ist abgelaufen. Starte sie erneut.');
        var store = keymanager();
        var previous = vaultEntries(store)[0];
        var slot = previous && previous.name === SLOTS[0] ? SLOTS[1] : SLOTS[0];
        var revision = Math.max(Date.now(), previous ? previous.value.revision + 1 : 1);
        removeSlot(store, slot);
        await nativeSave(store, slot, {version: 1, revision: revision, origin: config.origin,
          owner: value.owner, refresh: value.refresh});
        if (attempt !== generation || expiresAt && expiresAt <= Date.now()) {
          removeSlot(store, slot);
          ensureCurrent(attempt);
          throw failure('Die Anmeldung ist abgelaufen. Starte sie erneut.');
        }
        if (previous) {
          try { removeSlot(store, previous.name); }
          catch (_) { /* The newer complete slot remains authoritative. */ }
        }
      });
    }
    function clearVault() {
      return serializedVault(function () {
        var store = keymanager();
        SLOTS.forEach(function (name) { removeSlot(store, name); });
      });
    }
    function schedule(ms) {
      clearTimeout(timer);
      timer = undefined;
      if (owner) {
        timer = setTimeout(function () { timer = undefined; void exchange(); }, ms);
      }
    }
    async function bind(next, attempt) {
      owner = next;
      update({connected: Boolean(next), email: next ? next.email : '', lastSync: null});
      if (callbacks.onAccount) await callbacks.onAccount(next || null);
      ensureCurrent(attempt);
    }
    async function api(path, body, access) {
      if (!config || !global.KinoTransport) throw failure('Das KinoTix-Konto ist für diese Ausgabe nicht eingerichtet.');
      var target = new URL(path, config.origin);
      if (target.origin !== config.origin || target.hash || !path.startsWith('/')) {
        throw failure('Ungültige Anfrage an den KinoTix-Kontodienst.');
      }
      var headers = {apikey: config.key, Accept: 'application/json'};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (access) headers.Authorization = 'Bearer ' + access;
      var payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload && payload.length > MAX_BYTES) throw failure('Die Synchronisierungsanfrage ist zu groß.');
      var reply;
      try {
        reply = await global.KinoTransport.request(target.href, {method: body === undefined ? 'GET' : 'POST',
          headers: headers, body: payload, allowedHosts: [config.host], maxBytes: MAX_BYTES, dns: 'system', redirect: 'error'});
      } catch (_) { throw failure('Der KinoTix-Kontodienst ist gerade nicht erreichbar.'); }
      if (!reply || reply.url !== target.href) throw failure('Der KinoTix-Kontodienst hat unerwartet weitergeleitet.');
      if (reply.status < 200 || reply.status >= 300) {
        throw failure('Der KinoTix-Kontodienst ist gerade nicht verfügbar (HTTP ' + reply.status + ').', reply.status);
      }
      if (reply.status === 204 || !reply.body) return null;
      if (typeof reply.body !== 'string' || reply.body.length > MAX_BYTES) throw failure('Ungültige Antwort des KinoTix-Kontodienstes.');
      try { return JSON.parse(reply.body); }
      catch (_) { throw failure('Ungültige Antwort des KinoTix-Kontodienstes.'); }
    }
    async function token(grant, values) {
      var result = await api('/auth/v1/token?grant_type=' + grant, values);
      if (!result || typeof result.access_token !== 'string' || !tokenPattern.test(result.access_token) ||
          typeof result.refresh_token !== 'string' || !tokenPattern.test(result.refresh_token) ||
          !Number.isInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 86400) {
        throw failure('Der Kontodienst hat keine gültige Anmeldung geliefert.');
      }
      return {access: result.access_token, refresh: result.refresh_token, expiresAt: Date.now() + result.expires_in * 1000};
    }
    async function verified(value, expectedOwner) {
      var user = await api('/auth/v1/user', undefined, value.access);
      if (!validIdentity(user) || (expectedOwner && user.id.toLowerCase() !== expectedOwner.id)) {
        throw failure('Das Google-Konto konnte nicht bestätigt werden.');
      }
      return Object.assign({}, value, {owner: {id: user.id.toLowerCase(), email: user.email}});
    }
    async function revoke(value) {
      if (!value || !value.access) return;
      try { await api('/auth/v1/logout?scope=local', null, value.access); }
      catch (_) { /* Local removal remains effective while offline. */ }
    }

    function start() {
      if (startFlight) return startFlight;
      if (initialized) return Promise.resolve(status());
      initialized = true;
      var attempt = generation;
      startFlight = (async function () {
        update({restoring: true});
        config = await loadConfiguration();
        ensureCurrent(attempt);
        update({configured: Boolean(config)});
        if (!config) {
          update({message: 'Das Google-Konto ist für diese Samsung-Ausgabe noch nicht eingerichtet.'});
          return status();
        }
        var saved = vaultEntries(keymanager()).filter(function (entry) { return entry.value.origin === config.origin; })[0];
        if (saved) {
          ensureCurrent(attempt);
          session = {owner: {id: saved.value.owner.id.toLowerCase(), email: saved.value.owner.email},
            refresh: saved.value.refresh, access: '', expiresAt: 0};
          await bind(session.owner, attempt);
          schedule(0);
        }
        return status();
      })().catch(function (error) {
        if (attempt === generation) update({message: error.message});
        return status();
      }).finally(function () { update({restoring: false}); startFlight = undefined; });
      return startFlight;
    }

    function beginSignIn() {
      if (beginFlight) return beginFlight;
      beginFlight = (async function () {
        await start();
        if (!config) throw failure('Das Google-Konto ist für diese Ausgabe nicht eingerichtet.');
        if (owner || state.signingOut) throw failure('Ein Google-Konto ist bereits angemeldet.');
        keymanager();
        cancelSignIn();
        var attempt = generation;
        update({signingIn: true, message: ''});
        var verifier = randomToken(), readToken = randomToken();
        var hashes = await Promise.all([digest(verifier), digest(readToken)]);
        ensureCurrent(attempt);
        var ticket = await api(PAIRING + '/start', {challenge: hashes[0], readHash: hashes[1]});
        ensureCurrent(attempt);
        var prefix = config.origin + PAIRING + '/login/' + (ticket && ticket.id) + '/';
        if (!ticket || !/^[A-Za-z0-9_-]{22}$/.test(ticket.id) || typeof ticket.url !== 'string' ||
            !ticket.url.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(ticket.url.slice(prefix.length)) ||
            !Number.isInteger(ticket.expiresIn) || ticket.expiresIn < 1 || ticket.expiresIn > 300) {
          throw failure('Der Anmeldedienst hat keinen gültigen Anmeldelink geliefert.');
        }
        pairing = {id: ticket.id, verifier: verifier, readToken: readToken,
          expiresAt: Date.now() + ticket.expiresIn * 1000};
        update({qrUrl: ticket.url, expiresAt: pairing.expiresAt});
        return {url: ticket.url, expiresAt: pairing.expiresAt};
      })().catch(function (error) {
        if (!pairing && !owner) update({signingIn: false, message: error.message});
        throw error;
      }).finally(function () { beginFlight = undefined; });
      return beginFlight;
    }

    function pollSignIn() {
      if (pollFlight) return pollFlight;
      if (!pairing) return Promise.resolve(null);
      var attempt = generation, current = pairing;
      pollFlight = (async function () {
        requirePairing(attempt, current);
        if (candidate) return candidate.owner.email;
        if (!current.code && !current.tokens) {
          var result;
          try { result = await api(PAIRING + '/poll', {id: current.id, readToken: current.readToken}); }
          catch (error) { if (error.status === 429) return null; throw error; }
          requirePairing(attempt, current);
          if (result && result.status === 'pending') return null;
          if (result && result.status === 'expired') {
            cancelSignIn();
            throw failure('Die Anmeldung ist abgelaufen. Starte sie erneut.');
          }
          if (!result || result.status !== 'ready' || typeof result.code !== 'string' ||
              !/^[A-Za-z0-9._~-]{8,512}$/.test(result.code)) throw failure('Die Google-Anmeldung wurde abgebrochen. Starte sie erneut.');
          current.code = result.code;
        }
        if (!current.tokens) {
          try { current.tokens = await token('pkce', {auth_code: current.code, code_verifier: current.verifier}); }
          catch (error) {
            if (attempt === generation && error.status === 400) {
              cancelSignIn();
              throw failure('Die Anmeldung wurde unterbrochen. Starte sie erneut.');
            }
            throw error;
          }
          if (attempt !== generation) { void revoke(current.tokens); ensureCurrent(attempt); }
        }
        requirePairing(attempt, current);
        var value = await verified(current.tokens);
        requirePairing(attempt, current);
        candidate = value;
        update({awaitingConfirmation: true, email: value.owner.email,
          message: 'Bestätige dieses Google-Konto auf dem Fernseher.'});
        return value.owner.email;
      })().catch(function (error) {
        if (attempt === generation) update({message: error.message});
        throw error;
      }).finally(function () { pollFlight = undefined; });
      return pollFlight;
    }

    function confirmSignIn() {
      if (confirmFlight) return confirmFlight;
      var attempt = generation, current = pairing;
      confirmFlight = (async function () {
        requirePairing(attempt, current);
        if (!candidate) throw failure('Wähle zuerst ein Google-Konto aus.');
        var value = candidate;
        await saveSession(value, attempt, current.expiresAt);
        requirePairing(attempt, current);
        session = value;
        candidate = undefined;
        pairing = undefined;
        update({signingIn: false, awaitingConfirmation: false, qrUrl: '', expiresAt: null, message: ''});
        await bind(value.owner, attempt);
        schedule(0);
        return value.owner;
      })().catch(function (error) {
        if (attempt === generation) update({message: error.message});
        throw error;
      }).finally(function () { confirmFlight = undefined; });
      return confirmFlight;
    }

    function cancelSignIn() {
      if (owner) return;
      generation++;
      var discarded = pairing && pairing.tokens;
      pairing = undefined;
      candidate = undefined;
      update({signingIn: false, awaitingConfirmation: false, email: '', qrUrl: '', expiresAt: null, message: ''});
      void revoke(discarded);
    }

    async function access(attempt, rejected) {
      ensureCurrent(attempt);
      var current = session;
      if (!owner || !current) throw failure('Die Anmeldung ist nicht mehr aktiv.');
      if (current.access && current.expiresAt > Date.now() + 60000 && current.access !== rejected) return current.access;
      if (!refreshFlight) {
        var work = (async function () {
          var result;
          try {
            result = current.renewal || await token('refresh_token', {refresh_token: current.refresh});
            ensureCurrent(attempt);
            current.renewal = result;
            var value = await verified(result, current.owner);
            ensureCurrent(attempt);
            await saveSession(value, attempt);
            ensureCurrent(attempt);
            session = value;
            return value.access;
          } catch (error) {
            if (attempt !== generation && result) void revoke(result);
            throw error;
          }
        })();
        refreshFlight = work;
        work.finally(function () { if (refreshFlight === work) refreshFlight = undefined; }).catch(function () {});
      }
      var value = await refreshFlight;
      ensureCurrent(attempt);
      return value;
    }
    async function authenticated(path, body, attempt) {
      var auth = await access(attempt);
      var result;
      try { result = await api(path, body, auth); }
      catch (error) {
        if (error.status !== 401) throw error;
        auth = await access(attempt, auth);
        result = await api(path, body, auth);
      }
      ensureCurrent(attempt);
      return result;
    }
    async function readRows(kind, count, maximum, attempt) {
      var rows = [];
      for (var offset = 0; offset < maximum; offset += count) {
        var path = '/rest/v1/kinotix_sync?select=kind,item_id,updated_at,value&kind=eq.' + kind +
          '&order=updated_at.desc,item_id.asc&limit=' + count + '&offset=' + offset;
        var page = await authenticated(path, undefined, attempt);
        if (!Array.isArray(page) || page.length > count) throw failure('Der Kontodienst hat ungültige Synchronisierungsdaten geliefert.');
        rows = rows.concat(page.filter(function (row) { return row && row.kind === kind; }));
        if (page.length < count) break;
      }
      return rows;
    }
    function exchange() {
      if (syncFlight) return syncFlight;
      if (!owner || state.signingOut) return Promise.resolve(status());
      var attempt = generation;
      syncFlight = (async function () {
        var pending = callbacks.getPending ? await callbacks.getPending() : [];
        ensureCurrent(attempt);
        if (!Array.isArray(pending)) throw failure('Der lokale Wiedergabestand konnte nicht gelesen werden.');
        pending = pending.slice(0, 1000);
        for (var offset = 0; offset < pending.length; offset += 100) {
          var batch = pending.slice(offset, offset + 100);
          await authenticated('/rest/v1/rpc/kinotix_merge', {p_items: batch}, attempt);
          if (callbacks.acknowledge) await callbacks.acknowledge(batch);
          ensureCurrent(attempt);
        }
        var catalog = await readRows('catalog', 100, 100, attempt);
        var media = await readRows('media', 250, 5000, attempt);
        var progress = await readRows('progress', 500, 5000, attempt);
        ensureCurrent(attempt);
        if (callbacks.onRows) await callbacks.onRows(catalog.concat(media, progress));
        ensureCurrent(attempt);
        update({lastSync: Date.now(), message: ''});
        return status();
      })().catch(function () {
        if (attempt === generation) update({message: 'Abgleich gerade nicht möglich. Änderungen bleiben auf diesem Gerät gespeichert.'});
        return status();
      }).finally(function () {
        syncFlight = undefined;
        if (attempt === generation) schedule(30000);
      });
      return syncFlight;
    }

    function signOut() {
      if (signOutFlight) return signOutFlight;
      var ended = session;
      var refreshing = refreshFlight;
      var attempt = ++generation;
      clearTimeout(timer);
      timer = undefined;
      if (pairing && pairing.tokens) void revoke(pairing.tokens);
      pairing = undefined;
      candidate = undefined;
      update({signingOut: true, signingIn: false, awaitingConfirmation: false, qrUrl: '', expiresAt: null});
      signOutFlight = (async function () {
        await clearVault();
        ensureCurrent(attempt);
        session = undefined;
        await bind(null, attempt);
        update({message: ''});
        if (ended) {
          void (async function () {
            if (refreshing) await refreshing.catch(function () {});
            var value = ended.renewal || ended;
            if (!value.access || value.expiresAt <= Date.now()) {
              try { value = await token('refresh_token', {refresh_token: value.refresh}); }
              catch (_) { return; }
            }
            await revoke(value);
          })();
        }
        return status();
      })().catch(function () {
        update({message: 'Die gespeicherte Anmeldung konnte nicht entfernt werden. Versuche das Abmelden erneut.'});
        return status();
      }).finally(function () { update({signingOut: false}); signOutFlight = undefined; });
      return signOutFlight;
    }

    return {start: start, beginSignIn: beginSignIn, pollSignIn: pollSignIn, confirmSignIn: confirmSignIn,
      cancelSignIn: cancelSignIn, signOut: signOut, exchange: exchange, status: status};
  }

  global.KinoAccount = {create: create};
})(typeof window !== 'undefined' ? window : globalThis);
