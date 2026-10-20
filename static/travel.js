/* Travel information is temporary guidance. It never changes quote costs,
   project snapshots, shared prices or saved browser preferences. */
(() => {
  'use strict';
  let panel, origin, location, destination, map, tooltip, distance, duration, note, routeButton, projectEmpty;
  let point = null, previousAddress = '', revision = 0, controller = null, configured = false;
  const uiText = (element, text, args = []) => {
    if (window.CeasefireI18n?.text) window.CeasefireI18n.text(element,text,args);
    else element.textContent=String(text).replace(/\{(\d+)\}/g,(_,index)=>String(args[index]??''));
  };
  const node = (tag, text, className, args = []) => {
    const el = document.createElement(tag);
    if (text) uiText(el,text,args);
    if (className) el.className=className;
    return el;
  };
  const projectAddress = () => document.getElementById('site-address')?.value.trim() || '';
  function clear(message) {
    revision++;controller?.abort();controller=null;
    if (!panel) return;
    distance.textContent=duration.textContent='—';uiText(tooltip,'Check the driving route to see information from Google Maps.');
    panel.querySelector('.google-route-result').hidden=true;
    if(message)uiText(note,message);
    routeButton.disabled=false;
  }
  function refresh() {
    if(!panel)return;
    const value=projectAddress();
    if(value!==previousAddress){clear('Project address changed. Check the route again.');previousAddress=value;}
    destination.textContent=value;
    map.hidden=!value;
    projectEmpty.hidden=!!value;
    const url=new URL('https://www.google.com/maps/search/');url.searchParams.set('api','1');url.searchParams.set('query',value);
    map.href=url.href;
  }
  async function status() {
    try {const response=await fetch('/api/travel/status');if(!response.ok)throw Error();configured=(await response.json()).configured===true;}
    catch{configured=false;}
    const label=document.getElementById('google-maps-status');
    if(label)uiText(label,configured?'Google Maps is configured.':'Google Maps needs an API key before driving estimates are available.');
    if(panel&&!controller)uiText(note,configured?'Check the route to see approximate driving distance and time.':'Google Maps is not configured. You can still open the project in Google Maps.');
  }
  async function calculate() {
    refresh();clear();
    const address=projectAddress(),from=origin.value.trim();
    if(!address){uiText(note,'Enter the project Site Address above first.');return;}
    if(!point&&!from){uiText(note,'Enter your current address or choose Use current location.');return;}
    if(!configured){uiText(note,'Google Maps is not configured. Open the setup guide in Settings.');return;}
    const token=revision,request=new AbortController();controller=request;routeButton.disabled=true;uiText(note,'Checking the driving route…');
    try {
      const response=await fetch('/api/travel/route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin:point||{address:from},destination:address}),signal:request.signal});
      const result=await response.json();
      if(token!==revision||projectAddress()!==address)return;
      if(!response.ok){const error=Error(typeof result.error==='string'?result.error:'The driving route is unavailable.');error.ownedUiSource=typeof result.error!=='string';throw error;}
      if(!Number.isFinite(result.distance_meters)||result.distance_meters<0||!Number.isFinite(result.duration_seconds)||result.duration_seconds<0){const error=Error('The driving route is unavailable.');error.ownedUiSource=true;throw error;}
      const km=new Intl.NumberFormat(document.documentElement.lang||'en',{maximumFractionDigits:1}).format(result.distance_meters/1000);
      const minutes=Math.ceil(result.duration_seconds/60),time=minutes>=60?`${Math.floor(minutes/60)} h ${minutes%60} min`:`${minutes} min`;
      distance.textContent=`${km} km`;duration.textContent=time;
      const summary=typeof result.summary==='string'?result.summary:'';
      panel.querySelector('.google-route-summary').textContent=summary;
      const providerSummary=node('p');providerSummary.textContent=summary;
      tooltip.replaceChildren(node('strong','Google Maps'),node('p','{0} km · {1} by car',null,[km,time]),providerSummary);
      panel.querySelector('.google-route-result').hidden=false;
      uiText(note,'Approximate driving estimate. Traffic and the chosen route can change the journey.');
    } catch(error) {if(error.name!=='AbortError'&&token===revision){if(error.ownedUiSource)uiText(note,error.message);else note.textContent=error.message;}}
    finally{if(token===revision){controller=null;routeButton.disabled=false;}}
  }
  function build() {
    panel=node('section',null,'travel-details');panel.id='project-travel';panel.setAttribute('aria-labelledby','project-travel-heading');
    const title=node('h3','Project travel');title.id='project-travel-heading';
    const fields=node('div',null,'travel-locations'),current=node('label',null,'field');
    current.append(node('span','Current location'));origin=node('input');origin.type='text';origin.id='travel-current-location';origin.maxLength=400;origin.autocomplete='off';origin.placeholder='Enter your current address';window.CeasefireI18n?.attr(origin,'placeholder','Enter your current address');current.append(origin);
    location=node('button','Use current location','button secondary');location.type='button';location.id='travel-use-location';
    const project=node('div',null,'travel-project-location');project.append(node('span','Project location','travel-field-label'));map=node('a');map.id='travel-project-map';map.target='_blank';map.rel='noopener noreferrer';map.setAttribute('aria-describedby','travel-project-info');
    destination=node('span');map.append(destination);tooltip=node('div',null,'travel-location-popover');tooltip.id='travel-project-info';tooltip.setAttribute('role','tooltip');tooltip.setAttribute('translate','no');project.append(map,tooltip);
    projectEmpty=node('p','Enter the project Site Address above.','travel-project-empty');project.append(projectEmpty);
    fields.append(current,project);
    routeButton=node('button','Check driving route','button secondary');routeButton.type='button';routeButton.id='travel-calculate';
    const setup=node('a','Google Maps setup','text-button');setup.href='/maps-setup.html';setup.target='_blank';setup.rel='noopener';
    const actions=node('div',null,'actions');actions.append(location,routeButton,setup);
    const estimates=node('dl',null,'travel-estimates');
    for(const [label,id]of[['Approx. distance by car','travel-distance'],['Approx. travel time by car','travel-duration']]){const row=node('div');row.append(node('dt',label));const value=node('dd','—');value.id=id;row.append(value);estimates.append(row);if(id==='travel-distance')distance=value;else duration=value;}
    const result=node('div',null,'google-route-result');result.hidden=true;result.append(node('p',null,'google-route-summary'));
    const attribution=node('span','Google Maps','google-route-attribution');attribution.setAttribute('translate','no');result.append(attribution);
    note=node('p',null,'helper');note.id='travel-status';note.setAttribute('role','status');
    panel.append(title,fields,actions,estimates,result,note,node('p','Checking a route sends your chosen current location and the project address to Google. Locations and route results are not saved with the quote.','helper'));
    origin.addEventListener('input',()=>{point=null;clear('Current location changed. Check the route again.');});routeButton.addEventListener('click',calculate);
    location.addEventListener('click',()=>{
      clear();point=null;origin.value='';if(!navigator.geolocation){uiText(note,'Current location is unavailable. Enter your current address instead.');return;}
      const token=revision;location.disabled=true;uiText(note,'Waiting for location permission…');
      navigator.geolocation.getCurrentPosition(position=>{
        location.disabled=false;if(token!==revision)return;
        point={latitude:position.coords.latitude,longitude:position.coords.longitude};origin.value=`${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
        uiText(note,'Current location found. Choose Check driving route to send it to Google.');
      },()=>{location.disabled=false;if(token===revision)uiText(note,'Current location could not be read. Allow location access or enter your current address.');},{enableHighAccuracy:false,timeout:10000,maximumAge:60000});
    });
    for(const event of ['pointerenter','focus'])map.addEventListener(event,()=>{tooltip.hidden=false;refresh();});
    map.addEventListener('keydown',event=>{if(event.key==='Escape'){tooltip.hidden=true;event.preventDefault();}});
    clear();
  }
  document.addEventListener('input',event=>{if(event.target.id==='site-address')refresh();});
  document.addEventListener('click',event=>{if(event.target.closest?.('#google-maps-refresh'))status();});
  window.CeasefireTravel={attach(card){if(!card)return;if(!panel)build();card.append(panel);refresh();status();}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',status,{once:true});else status();
})();
