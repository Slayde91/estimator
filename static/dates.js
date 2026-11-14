(() => {
  'use strict';
  const formatters = new Map();
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/;
  function validDay(value) {
    const match = isoDay.exec(value);
    if (!match || match[1] === '0000') return false;
    const parsed = new Date(value+'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
  }
  function parts(value, timeZone) {
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return null;
    const zoneKey = timeZone || '';
    if (!formatters.has(zoneKey)) formatters.set(zoneKey,new Intl.DateTimeFormat('en-GB',{
      timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
    }));
    return Object.fromEntries(formatters.get(zoneKey).formatToParts(instant).map(part=>[part.type,part.value]));
  }
  function date(value, {timeZone}={}) {
    if (value == null || value === '') return '';
    if (typeof value==='string' && isoDay.test(value)) {
      return validDay(value) ? value.slice(8)+'/'+value.slice(5,7)+'/'+value.slice(0,4) : value;
    }
    const p=parts(value,timeZone);
    return p ? p.day+'/'+p.month+'/'+p.year.padStart(4,'0') : String(value);
  }
  function dateTime(value, {timeZone,seconds=true}={}) {
    if (value == null || value === '') return '';
    if (typeof value==='string' && isoDay.test(value)) return date(value);
    const p=parts(value,timeZone);
    return p ? p.day+'/'+p.month+'/'+p.year.padStart(4,'0')+' '+p.hour+':'+p.minute+(seconds?':'+p.second:'') : String(value);
  }
  // Reports and local form entries carry their own wall clock, offset and precision.
  function wallTime(value) {
    if (typeof value!=='string') return dateTime(value);
    const match=/^(\d{4}-\d\d-\d\d)(?:[T ](\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?))?$/.exec(value);
    return match && validDay(match[1]) ? date(match[1])+(match[2]?' '+match[2]:'') : value;
  }
  function parseDate(text) {
    const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    const day=match ? match[3]+'-'+match[2]+'-'+match[1] : '';
    return validDay(day) ? day : '';
  }
  window.ClassifireDates=Object.freeze({date,dateTime,wallTime,parseDate});
})();
