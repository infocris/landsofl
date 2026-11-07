// Lecture de la RAM du PC émulé par js-dos (mode direct, workerThread: false).
// Utilisé par la surcouche mini-carte et par les outils de recherche de variables.
(() => {
  "use strict";
  const BIOS_SIG = "IBM COMPATIBLE";
  const BIOS_SIG_PHYS = 0xFE00E;          // emplacement de la signature dans la ROM BIOS de DOSBox
  const RAM_SIZE = 16 * 1024 * 1024;      // memsize=16 dans dosbox.conf

  function heapOf(ci) {
    const m = ci && ci.transport && ci.transport.module;
    return m && m.HEAPU8 ? m.HEAPU8 : null;   // HEAPU8 peut être remplacé si la mémoire grandit
  }

  // Adresse, dans le tas WebAssembly, de l'adresse physique 0 du PC émulé.
  function findMemBase(heap) {
    const sig = Array.from(BIOS_SIG, (c) => c.charCodeAt(0));
    outer: for (let i = 0; i < heap.length - sig.length; i++) {
      if (heap[i] !== sig[0]) continue;
      for (let k = 1; k < sig.length; k++) if (heap[i + k] !== sig[k]) continue outer;
      const base = i - BIOS_SIG_PHYS;
      if (base >= 0 && heap[base + 0xFFFF0] === 0xEA) return base;   // vecteur de reset : JMP FAR
    }
    return -1;
  }

  class DosMemory {
    constructor(ci) { this.ci = ci; this.base = -1; }
    get heap() { return heapOf(this.ci); }
    ready() {
      const h = this.heap;
      if (!h) return false;
      if (this.base < 0) {
        // la recherche parcourt tout le tas : pas plus d'une fois toutes les 2 s
        const now = Date.now();
        if (this.nextTry && now < this.nextTry) return false;
        this.base = findMemBase(h);
        this.nextTry = now + 2000;
      }
      return this.base >= 0;
    }
    u8(phys) { return this.heap[this.base + phys]; }
    u16(phys) { const h = this.heap, a = this.base + phys; return h[a] | (h[a + 1] << 8); }
    snapshot() { const h = this.heap; return h.slice(this.base, this.base + RAM_SIZE); }
  }

  // Lecture à distance : l'émulateur reste dans son worker (emulators/wdosbox-x.js modifié),
  // qui répond sur le canal « lol-mem ». read() renvoie null si le jeu ne répond pas.
  class RemoteMemory {
    constructor() {
      this.ch = new BroadcastChannel("lol-mem");
      this.pending = new Map();
      this.seq = 0;
      this.ch.onmessage = (e) => {
        const p = this.pending.get(e.data && e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        p(e.data.error ? null : e.data.data);
      };
    }
    read(ranges, timeout = 1000) {
      const id = ++this.seq;
      return new Promise((resolve) => {
        this.pending.set(id, resolve);
        this.ch.postMessage({ id, ranges });
        setTimeout(() => { if (this.pending.delete(id)) resolve(null); }, timeout);
      });
    }
  }

  window.LoLMem = { DosMemory, RemoteMemory, findMemBase, RAM_SIZE };
})();
