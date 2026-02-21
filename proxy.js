"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns");

const LISTEN_HOST = process.env.PROXY_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.PORT || process.env.PROXY_PORT || 3128);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 20000);
const ALLOW_CONNECT_PORTS = parsePortList(process.env.ALLOW_CONNECT_PORTS || "");
const HOST_MAP = parseHostMap(process.env.HOST_MAP || "");
const RESOLVER = createResolver(process.env.DNS_SERVERS || "");
const SHOULD_OVERRIDE_LOOKUP = HOST_MAP.size > 0 || Boolean(RESOLVER);

function parsePortList(raw) {
  if (!raw.trim()) return null;
  const set = new Set();
  for (const part of raw.split(",")) {
    const value = Number(part.trim());
    if (Number.isInteger(value) && value > 0 && value <= 65535) {
      set.add(value);
    }
  }
  return set.size > 0 ? set : null;
}

function parseHostMap(raw) {
  const map = new Map();
  if (!raw.trim()) return map;

  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const host = trimmed.slice(0, eq).trim().toLowerCase();
    const ip = trimmed.slice(eq + 1).trim();
    if (!host || !net.isIP(ip)) continue;

    map.set(host, ip);
  }
  return map;
}

function createResolver(rawServers) {
  const servers = rawServers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (servers.length === 0) return null;

  const resolver = new dns.Resolver();
  resolver.setServers(servers);
  return resolver;
}

function normalizeLookupOptions(options) {
  if (typeof options === "number") return { family: options };
  if (!options || typeof options !== "object") return {};
  return options;
}

function mapLookupResult(addresses, all, callback) {
  if (!addresses || addresses.length === 0) {
    callback(new Error("DNS resolve returned no address"));
    return;
  }
  if (all) {
    callback(
      null,
      addresses.map((address) => ({
        address,
        family: net.isIP(address),
      }))
    );
    return;
  }
  callback(null, addresses[0], net.isIP(addresses[0]));
}

function resolveByResolver(hostname, family, all, callback) {
  const resolve4 = () =>
    new Promise((resolve, reject) => {
      RESOLVER.resolve4(hostname, (err, addresses) => (err ? reject(err) : resolve(addresses)));
    });
  const resolve6 = () =>
    new Promise((resolve, reject) => {
      RESOLVER.resolve6(hostname, (err, addresses) => (err ? reject(err) : resolve(addresses)));
    });

  (async () => {
    try {
      if (family === 4) {
        mapLookupResult(await resolve4(), all, callback);
        return;
      }
      if (family === 6) {
        mapLookupResult(await resolve6(), all, callback);
        return;
      }

      const out4 = await resolve4().catch(() => []);
      const out6 = await resolve6().catch(() => []);
      const merged = [...out4, ...out6];
      if (merged.length === 0) {
        callback(new Error(`Cannot resolve ${hostname}`));
        return;
      }
      mapLookupResult(merged, all, callback);
    } catch (err) {
      callback(err);
    }
  })();
}

function customLookup(hostname, options, callback) {
  const normalized = normalizeLookupOptions(options);
  const all = Boolean(normalized.all);
  const family = Number.isInteger(normalized.family) ? normalized.family : 0;

  if (net.isIP(hostname)) {
    mapLookupResult([hostname], all, callback);
    return;
  }

  const mapped = HOST_MAP.get(hostname.toLowerCase());
  if (mapped) {
    mapLookupResult([mapped], all, callback);
    return;
  }

  if (!RESOLVER) {
    dns.lookup(hostname, normalized, callback);
    return;
  }

  resolveByResolver(hostname, family, all, callback);
}

function stripProxyHeaders(headers) {
  const clean = { ...headers };
  delete clean["proxy-connection"];
  delete clean["proxy-authenticate"];
  delete clean["proxy-authorization"];
  return clean;
}

function parseAuthority(authority, defaultPort) {
  if (!authority) return null;
  const value = authority.trim();
  if (!value) return null;

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    const host = value.slice(1, end);
    const suffix = value.slice(end + 1);
    if (!suffix) return { host, port: defaultPort };
    if (!suffix.startsWith(":")) return null;
    const port = Number(suffix.slice(1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  }

  const idx = value.lastIndexOf(":");
  if (idx === -1 || value.indexOf(":") !== idx) {
    return { host: value, port: defaultPort };
  }

  const host = value.slice(0, idx);
  const port = Number(value.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function sendSimpleResponse(socketOrRes, statusCode, text) {
  const message = text || "Error";
  if (typeof socketOrRes.writeHead === "function") {
    socketOrRes.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
    socketOrRes.end(message);
    return;
  }

  socketOrRes.end(
    `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] || "Error"}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "Connection: close\r\n\r\n" +
      message
  );
}

function toTargetUrl(req) {
  try {
    return new URL(req.url);
  } catch {
    if (!req.headers.host) return null;
    return new URL(`http://${req.headers.host}${req.url}`);
  }
}

const server = http.createServer((clientReq, clientRes) => {
  const target = toTargetUrl(clientReq);
  if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
    sendSimpleResponse(clientRes, 400, "Invalid target URL");
    return;
  }

  const upstreamHeaders = stripProxyHeaders(clientReq.headers);

  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: clientReq.method,
    path: `${target.pathname}${target.search}`,
    headers: upstreamHeaders,
    lookup: SHOULD_OVERRIDE_LOOKUP ? customLookup : undefined,
    agent: false,
  };

  const requestFn = target.protocol === "https:" ? https.request : http.request;
  const upstreamReq = requestFn(requestOptions, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error("Upstream request timeout"));
  });

  upstreamReq.on("error", (err) => {
    const status = err.message.includes("timeout") ? 504 : 502;
    sendSimpleResponse(clientRes, status, `Proxy request failed: ${err.message}`);
  });

  clientReq.on("aborted", () => {
    upstreamReq.destroy();
  });

  clientReq.pipe(upstreamReq);
});

server.on("connect", (req, clientSocket, head) => {
  const target = parseAuthority(req.url, 443);
  if (!target) {
    sendSimpleResponse(clientSocket, 400, "Invalid CONNECT target");
    return;
  }

  if (ALLOW_CONNECT_PORTS && !ALLOW_CONNECT_PORTS.has(target.port)) {
    sendSimpleResponse(clientSocket, 403, "CONNECT port is not allowed");
    return;
  }

  const upstreamSocket = net.connect({
    host: target.host,
    port: target.port,
    lookup: SHOULD_OVERRIDE_LOOKUP ? customLookup : undefined,
  });

  let handshakeDone = false;

  upstreamSocket.setTimeout(CONNECT_TIMEOUT_MS, () => {
    upstreamSocket.destroy(new Error("CONNECT timeout"));
  });

  upstreamSocket.on("connect", () => {
    handshakeDone = true;
    clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: proxydns\r\n\r\n");
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on("error", (err) => {
    if (!handshakeDone) {
      const status = err.message.includes("timeout") ? 504 : 502;
      sendSimpleResponse(clientSocket, status, `CONNECT failed: ${err.message}`);
      return;
    }
    clientSocket.destroy();
  });

  clientSocket.on("error", () => {
    upstreamSocket.destroy();
  });
});

server.on("clientError", (err, socket) => {
  sendSimpleResponse(socket, 400, `Client error: ${err.message}`);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const mapText = HOST_MAP.size > 0 ? [...HOST_MAP.entries()].map(([h, ip]) => `${h}=${ip}`).join(", ") : "(none)";
  const dnsText = RESOLVER ? (process.env.DNS_SERVERS || "").trim() : "(system default)";

  console.log(`Proxy listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`HOST_MAP: ${mapText}`);
  console.log(`DNS servers: ${dnsText}`);
  if (ALLOW_CONNECT_PORTS) {
    console.log(`Allowed CONNECT ports: ${[...ALLOW_CONNECT_PORTS].sort((a, b) => a - b).join(", ")}`);
  }
});
