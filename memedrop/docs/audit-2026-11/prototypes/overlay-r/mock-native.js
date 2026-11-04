window.__rects = []; window.__ticks = 0;
window.MDOverlay = { rects(j) { window.__rects.push(j); } };
const qsa = Document.prototype.querySelectorAll;
Document.prototype.querySelectorAll = function (sel) { if (sel === '#stage .anchor') window.__ticks++; return qsa.call(this, sel); };
