/* worker.js: laadt het netwerk en rekent isochronen buiten de hoofdthread. */
/* global IsoCore */
importScripts('../vendor/d3-array.min.js', '../vendor/d3-contour.min.js', 'core.js');

let engine = null;

async function fetchBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Kan ' + url + ' niet laden (HTTP ' + resp.status + ')');
  return IsoCore.gunzip(await resp.arrayBuffer());
}

async function init(basis) {
  const t0 = Date.now();
  postMessage({ type: 'voortgang', tekst: 'Netwerk downloaden…' });
  const metaResp = await fetch(basis + 'network.json');
  if (!metaResp.ok) throw new Error('Kan network.json niet laden (HTTP ' + metaResp.status + ')');
  const meta = await metaResp.json();
  const [netBuf, inwBuf] = await Promise.all([
    fetchBuffer(basis + 'network.bin.gz'),
    fetchBuffer(basis + 'inwoners.bin.gz'),
  ]);
  postMessage({ type: 'voortgang', tekst: 'Netwerk opbouwen…' });
  const net = IsoCore.parseNetwork(meta, netBuf);
  const inwoners = IsoCore.parseInwoners(inwBuf);
  engine = IsoCore.createEngine(net, inwoners);
  postMessage({ type: 'klaar', meta, ms: Date.now() - t0 });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      await init(m.basis);
    } else if (m.type === 'bereken') {
      if (!engine) throw new Error('Het netwerk is nog niet geladen.');
      const res = engine.compute(m.verzoek);
      postMessage({ type: 'resultaat', id: m.id, resultaat: res });
    }
  } catch (err) {
    postMessage({ type: 'fout', id: m.id, tekst: String((err && err.message) || err) });
  }
};
