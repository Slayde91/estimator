(() => {
  'use strict';
  // Chromium uses the operating-system region for both native input segments
  // and its range validation message. Probe an unambiguous native date: CSS
  // segment reordering alone would leave month-first keyboard editing intact.
  const probe=document.createElement('input');
  probe.type='date';probe.max='2026-11-23';probe.value='2026-11-24';
  const locale=new Intl.DateTimeFormat(undefined,{day:'2-digit',month:'2-digit',year:'numeric'});
  const separators=locale.formatToParts(new Date(2026,10,15))
    .filter(part=>part.type==='literal');
  const {calendar,numberingSystem}=locale.resolvedOptions();
  if (CSS.supports('selector(input::-webkit-datetime-edit-day-field)') && probe.validationMessage.includes('23/11/2026') &&
      calendar==='gregory' && numberingSystem==='latn' && separators.every(part=>part.value==='/')) return;
  const {wallTime,parseDate}=window.ClassifireDates;
  const fields='input[type=date],input[type=datetime-local]';
  const inputs=new WeakMap();
  let sequence=0;
  const localize=text=>window.CeasefireI18n?.translate(text) || text;
  function enhance(native) {
    if (inputs.has(native) || native.closest('.scheduler-report-date') || !native.parentNode) return;
    const timed=native.type==='datetime-local';
    const wrapper=document.createElement('span'),text=document.createElement('input');
    wrapper.className='classifire-date-control';text.className='date-text';
    text.placeholder=timed?'DD/MM/YYYY HH:MM':'DD/MM/YYYY';
    const labels=Array.from(native.labels || []), referenced=native.getAttribute('aria-labelledby');
    const label=(referenced || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent.trim()).filter(Boolean).join(' ') ||
      native.getAttribute('aria-label') || labels.map(item=>item.textContent.trim()).join(' ') || localize('Date');
    text.id='classifire-date-text-'+ ++sequence;
    if(referenced)text.setAttribute('aria-labelledby',referenced);
    else text.setAttribute('aria-label',label);
    for(const item of labels) if(item.htmlFor===native.id && native.id)item.htmlFor=text.id;
    if (native.hasAttribute('aria-describedby')) text.setAttribute('aria-describedby',native.getAttribute('aria-describedby'));
    native.removeAttribute('aria-labelledby');
    native.setAttribute('aria-label',localize('Choose date')+' · '+label);
    const syncValue=()=>{
      text.value=wallTime(native.value);text.setCustomValidity('');
      if(native.validationMessage===text.placeholder)native.setCustomValidity('');
    };
    const syncState=()=>{
      text.required=native.required;text.disabled=native.disabled;text.readOnly=native.readOnly;
      wrapper.hidden=native.hidden;
    };
    inputs.set(native,{syncValue,syncState});
    native.before(wrapper);wrapper.append(text);
    const ns='http://www.w3.org/2000/svg',icon=document.createElementNS(ns,'svg'),path=document.createElementNS(ns,'path');
    icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','2');icon.setAttribute('aria-hidden','true');
    path.setAttribute('d','M3 6h18v15H3z M3 10h18 M8 3v5 M16 3v5');icon.append(path);
    native.classList.add('native-calendar');wrapper.append(icon,native);
    // Application renderers routinely assign .value without dispatching input.
    const property=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
    Object.defineProperty(native,'value',{configurable:true,get(){return property.get.call(this);},set(value){property.set.call(this,value);syncValue();}});
    syncValue();syncState();
    let forwarding=false;
    for(const eventType of ['input','change']) {
      text.addEventListener(eventType,event=>{
        event.stopPropagation();
        let entered=text.value.trim();
        // Pasted ISO values from the register or another system are accepted
        // only after the same real-calendar and native time validation.
        if (/^\d{4}-\d\d-\d\d(?:[T ]|$)/.test(entered)) entered=wallTime(entered);
        const [day,clock,...extra]=entered.split(/\s+/);
        const iso=parseDate(day);
        const timeValid=timed ? /^\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/.test(clock || '') : !clock;
        property.set.call(native,iso && timeValid && !extra.length ? iso+(timed?'T'+clock:'') : '');
        if(native.value && entered!==text.value.trim())text.value=wallTime(native.value);
        const malformed=Boolean(text.value && !native.value);
        native.setCustomValidity(malformed ? text.placeholder : '');
        text.setCustomValidity(native.validationMessage);
        forwarding=true;
        try {native.dispatchEvent(new Event(eventType,{bubbles:true}));} finally {forwarding=false;}
      });
      native.addEventListener(eventType,()=>{if(!forwarding){native.setCustomValidity('');syncValue();}});
    }
    native.addEventListener('invalid',()=>text.focus());
    native.addEventListener('click',()=>{if(native.showPicker && !native.disabled && !native.readOnly){try{native.showPicker();}catch{}}});
  }
  function scan(node) {
    if (node.nodeType!==1) return;
    if (node.matches(fields)) enhance(node);
    node.querySelectorAll(fields).forEach(enhance);
  }
  scan(document.documentElement);
  document.addEventListener('reset',event=>queueMicrotask(()=>{
    if(!event.defaultPrevented)for(const input of event.target.elements || [])inputs.get(input)?.syncValue();
  }),true);
  new MutationObserver(records=>{
    for(const record of records) {
      if(record.type==='attributes'){
        const state=inputs.get(record.target);
        if(state){if(record.attributeName==='value')state.syncValue();else state.syncState();}
        else if(record.target.matches(fields))enhance(record.target);
      }
      else for(const node of record.addedNodes)scan(node);
    }
  }).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['value','disabled','readonly','hidden','required','type']});
})();
