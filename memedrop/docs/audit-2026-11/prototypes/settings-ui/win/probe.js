const cs = getComputedStyle(document.body, '::before');
const out = {
  before_backgroundImage: cs.backgroundImage,
  before_filter: cs.filter,
  before_position: cs.position,
  before_content: cs.content,
  css_supports_bad: CSS.supports('background', 'radial-gradient(55% 45% at 15% 0%, rgba(255,94,138,.16) transparent 65%)'),
  css_supports_good: CSS.supports('background', 'radial-gradient(55% 45% at 15% 0%, rgba(255,94,138,.16), transparent 65%)'),
  grain_blend: getComputedStyle(document.querySelector('.grain')).mixBlendMode,
};
document.getElementById('out').textContent = JSON.stringify(out, null, 1);
