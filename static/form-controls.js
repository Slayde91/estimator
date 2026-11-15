(() => {
  'use strict';

  const icons = {
    back:      ['secondary', 'button-symbol', '←'],
    close:     ['secondary', 'button-symbol', '×'],
    up:        ['secondary', 'button-symbol', '↑'],
    down:      ['secondary', 'button-symbol', '↓'],
    duplicate: ['secondary', 'button-symbol', '⧉'],
    remove:    ['secondary trash-button', 'trash-artwork'],
    pdf:       ['primary', 'download-format-icon'],
    add:       ['primary add-icon-action', 'button-symbol add-symbol', '+'],
    signature: ['secondary personal-signature-button takeoff-icon-button takeoff-signature-button', 'takeoff-action-icon takeoff-signature-icon'],
    clear:     ['secondary', 'form-clear-icon'],
    sketch:    ['secondary', 'form-sketch-icon'],
  };

  function iconButton(label, kind, onClick) {
    const [buttonClass, iconClass, symbol] = icons[kind];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button icon-only form-control-icon ' + buttonClass;
    for (const attribute of ['aria-label', 'title']) {
      button.setAttribute(attribute, label);
      window.CeasefireI18n?.attr(button, attribute, label);
    }
    const icon = document.createElement('span');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    if (symbol) icon.textContent = symbol;
    if (kind === 'pdf') {
      const arrow = document.createElement('span');
      arrow.className = 'download-arrow';
      arrow.textContent = '⇩';
      const format = document.createElement('span');
      format.className = 'download-format';
      format.textContent = 'PDF';
      icon.append(arrow, format);
    }
    button.append(icon);
    button.addEventListener('click', onClick);
    return button;
  }

  window.ClassifireFormControls = {iconButton};
})();
