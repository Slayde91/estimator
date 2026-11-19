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

  async function signatureDetails(memberId) {
    const [profileResponse, sessionResponse] = await Promise.all([
      fetch('/api/forms/signer', {cache:'no-store'}),
      fetch('/api/scheduler/bootstrap', {cache:'no-store'}),
    ]);
    if (!profileResponse.ok || !sessionResponse.ok) throw new Error('Personal details could not be loaded. Try again.');
    const [profile, session] = await Promise.all([profileResponse.json(), sessionResponse.json()]);
    if (!memberId || profile.id !== memberId || session.user?.id !== memberId || window.ClassifireAccess?.user?.id !== memberId) {
      throw new Error('Your signature profile changed. Reopen the signature pad.');
    }
    if (!profile.name?.trim() || !profile.at || !session.timezone) throw new Error('Personal details could not be loaded. Try again.');
    const date = window.ClassifireDates.parseDate(window.ClassifireDates.date(profile.at, {timeZone:session.timezone}));
    if (!date) throw new Error('Personal details could not be loaded. Try again.');
    return {member_id:memberId, name:profile.name, date};
  }

  function registerSignature({entry, el, field, isCurrent, onChange, onError}) {
    const card = el('section','card register-signature-section');
    card.append(el('h2','','Signature'));
    const signer = el('div','register-grid'), details = entry.signature_details;
    for (const [label, value] of [['Name', details?.name || ''], ['Date', details ? window.ClassifireDates.date(details.date) : '']]) {
      const input = el('input');
      input.readOnly = true;
      input.value = value;
      signer.append(field(label,input));
    }
    card.append(signer);
    if (entry.signature) {
      const image = el('img','register-signature');
      image.alt = 'Signature';
      image.src = window.ClassifirePersonalSignature.png(entry.signature);
      card.append(image);
    }
    const actions = el('div','register-signature-actions');
    const insert = iconButton('Insert signature','signature',async () => {
      const memberId = window.ClassifireAccess?.user?.id;
      insert.disabled = true;
      try {
        const signature = await window.ClassifirePersonalSignature.choose(entry.signature);
        if (!signature || !insert.isConnected || !isCurrent()) return;
        const details = await signatureDetails(memberId);
        if (!insert.isConnected || !isCurrent()) return;
        entry.signature = signature;
        entry.signature_details = details;
        onChange();
      } catch (error) {
        if (insert.isConnected && isCurrent()) onError(error.message);
      } finally {
        insert.disabled = false;
      }
    });
    actions.append(insert);
    if (entry.signature) {
      const clear = iconButton('Clear signature','clear',() => {
        entry.signature = null;
        delete entry.signature_details;
        onChange();
      });
      const artwork = document.querySelector('#penetration-clear svg')?.cloneNode(true);
      if (artwork) {
        artwork.setAttribute('aria-hidden','true');
        artwork.setAttribute('focusable','false');
        clear.replaceChildren(artwork);
      }
      actions.append(clear);
    }
    card.append(actions);
    return card;
  }

  window.ClassifireFormControls = {iconButton, registerSignature};
})();
