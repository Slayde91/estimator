(() => {
  'use strict';
  const columns = {elapsed:'Clocked time',paid:'Paid time',regular:'Regular',overtime:'Overtime / penalty',
    paid_break:'Paid breaks',unpaid_break:'Unpaid breaks'};
  const keys = Object.keys(columns);
  const hours = seconds => {
    const minutes = Math.round(seconds / 60);
    return Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'m';
  };
  function node(tag,text,cls) {
    const item=document.createElement(tag);
    if (text != null) item.textContent=text;
    if (cls) item.className=cls;
    return item;
  }
  function sum(rows) {
    return Object.fromEntries(keys.map(key=>[key,rows.reduce((value,row)=>value+row[key],0)]));
  }
  function groups(rows,key) {
    const result=new Map();
    for (const row of rows) {
      if (!result.has(row[key])) result.set(row[key],[]);
      result.get(row[key]).push(row);
    }
    return result;
  }
  function chart(title,rows,key,label) {
    const section=node('section',null,'card scheduler-report-chart');
    section.append(node('h3',title));
    const values=Array.from(groups(rows,key),([id,items])=>({id,label:label(items[0]),value:sum(items).paid}));
    values.sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label));
    const max=Math.max(1,values[0]?.value || 0);
    for (const item of values) {
      const line=node('div',null,'scheduler-report-bar');
      const bar=node('progress'); bar.max=max; bar.value=item.value; bar.setAttribute('aria-label',item.label);
      line.append(node('span',item.label),node('strong',hours(item.value)),bar); section.append(line);
    }
    return section;
  }
  function csv(values) {
    return values.map(row=>row.map(value=>{
      let text=String(value ?? '');
      if (/^\s*[=+@-]|^[\t\r\n]/.test(text)) text="'"+text;
      return '"'+text.replace(/"/g,'""')+'"';
    }).join(',')).join('\r\n');
  }
  function render(root,state,{request,translated:t,addDays,weekStart,zone}) {
    const host=node('section',null,'scheduler-reports'), title=node('h2'), modes=node('div',null,'scheduler-report-modes');
    host.dataset.zone=zone; host.dataset.language=document.documentElement.lang;
    const filters=node('form',null,'card scheduler-report-filters'), output=node('div',null,'scheduler-report-output');
    const announcement=node('p',null,'helper'); announcement.setAttribute('role','status');
    let data=null, ticket=0;
    const control=(text,kind='select')=>{
      const field=node('label',null,'field'), item=node(kind);
      item.setAttribute('aria-label',t(text));
      field.append(node('span',t(text)),item); filters.append(field); return item;
    };
    const action=(text,handler,cls='button secondary')=>{
      const b=node('button',t(text),cls); b.type='button'; b.addEventListener('click',handler); return b;
    };
    for (const [id,text] of [['payroll','Payroll Report'],['project','Project Report']]) {
      const b=action(text,()=>{state.kind=id; draw();}); b.dataset.report=id; modes.append(b);
    }
    const period=control('Reporting period'), start=control('Start date','input'), end=control('End date','input');
    for (const [id,label] of [['week','Week'],['month','Month'],['custom','Custom']]) period.add(new Option(t(label),id));
    period.value=state.period; start.type=end.type='date'; start.required=end.required=true;
    start.value=state.start; end.value=state.end;
    const member=control('Team member'), project=control('Project'), job=control('Job');
    const all=t('All'), unassigned=t('Unassigned');
    function populate(select,rows,selected) {
      select.replaceChildren(new Option(all,''));
      for (const [id,label] of [...rows].sort((a,b)=>a[1].localeCompare(b[1])||a[0].localeCompare(b[0])))
        select.add(new Option(label,id));
      select.value=selected;
      if (select.selectedIndex<0) select.value='';
      return select.value;
    }
    const run=node('button',t('Run report'),'button scheduler-primary-action'); run.type='submit'; filters.append(run);
    function setPeriod() {
      if (!start.value || period.value==='custom') return;
      if (period.value==='week') {
        start.value=weekStart(start.value); end.value=addDays(start.value,6);
      } else {
        const current=new Date(start.value+'T12:00:00Z');
        start.value=start.value.slice(0,7)+'-01';
        end.value=new Date(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()+1,0,12)).toISOString().slice(0,10);
      }
    }
    // Never present a completed report under dates for which it has not run.
    function invalidate() {++ticket; data=null; output.replaceChildren(); announcement.textContent=''; run.disabled=false;}
    period.addEventListener('change',()=>{setPeriod(); invalidate();});
    start.addEventListener('change',()=>{setPeriod(); invalidate();});
    end.addEventListener('change',()=>{period.value='custom'; invalidate();});
    function projectLabel(row) {return row.project_label || unassigned;}
    function jobLabel(row) {return row.job_label || unassigned;}
    function fillJobs() {
      const rows=data.rows.filter(row=>!state.project || row.project===state.project);
      state.job=populate(job,new Map(rows.map(row=>[row.job,jobLabel(row)])),state.job);
    }
    member.addEventListener('change',()=>{state.member=member.value;draw();});
    project.addEventListener('change',()=>{state.project=project.value;if (data)fillJobs();draw();});
    job.addEventListener('change',()=>{state.job=job.value;draw();});
    async function load(event) {
      event?.preventDefault();
      const current=++ticket; data=null; output.replaceChildren(); run.disabled=true;
      announcement.textContent=t('Loading…');
      state.period=period.value; state.start=start.value; state.end=end.value;
      try {
        const result=await request('/reports?'+new URLSearchParams({start:state.start,end:state.end}));
        if (current!==ticket || !host.isConnected) return;
        data=result; announcement.textContent='';
        state.member=populate(member,Object.entries(data.members),state.member);
        state.project=populate(project,new Map(data.rows.map(row=>[row.project,projectLabel(row)])),state.project);
        fillJobs(); draw();
      } catch (err) {
        if (current===ticket && host.isConnected) announcement.textContent=t(err.message);
      } finally {if (current===ticket) run.disabled=false;}
    }
    filters.addEventListener('submit',load);
    function draw() {
      const payroll=state.kind==='payroll';
      title.textContent=t(payroll?'Payroll Report':'Project Report');
      for (const btn of modes.children) btn.setAttribute('aria-pressed',String(btn.dataset.report===state.kind));
      output.replaceChildren();
      if (!data) return;
      const rows=data.rows.filter(row=>(!state.member||row.member===state.member) &&
        (!state.project||row.project===state.project) && (!state.job||row.job===state.job));
      const name=row=>data.members[row.member] || unassigned;
      const totals=sum(rows), classified=data.pay_status==='calculated';
      const display=(key,value)=>!classified && ['regular','overtime'].includes(key)?'—':hours(value);
      const scope=[state.start+' – '+state.end,data.timezone];
      for(const select of [member,project,job]) if(select.value) scope.push(select.selectedOptions[0].textContent);
      output.append(node('p',scope.join(' · '),'helper'));
      if (!rows.length) {output.append(node('p',t('No completed time entries match these filters.'),'notice'));return;}
      const fields=payroll?['paid','regular','overtime','paid_break','unpaid_break']:['paid','paid_break','unpaid_break'];
      const summary=node('dl',null,'scheduler-report-totals');
      for (const key of fields) {
        const tile=node('div',null,'card'); tile.append(node('dt',t(columns[key])),node('dd',display(key,totals[key])));summary.append(tile);
      }
      output.append(summary);
      if (payroll && !classified) output.append(node('p',t('Confirm pay rules before calculating pay.'),'helper'));
      for (const message of data.warnings) output.append(node('p',message,'helper'));
      if (!payroll) {
        const charts=node('div',null,'scheduler-report-charts');
        charts.append(chart(t('Jobs'),rows,'job',jobLabel),chart(t('Projects'),rows,'project',projectLabel),
          chart(t('Team members'),rows,'member',name)); output.append(charts);
      }
      const tools=node('div',null,'scheduler-report-tools');
      const dimensions=['Date','Team member','Project','Job','Clock in','Clock out'];
      const sorted=rows.slice().sort((a,b)=>name(a).localeCompare(name(b))||a.day.localeCompare(b.day)||Date.parse(a.clock_in)-Date.parse(b.clock_in));
      const detail=row=>[row.day,name(row),projectLabel(row),jobLabel(row),row.clock_in,row.clock_out];
      const clock=instant=>instant.replace('T',' ').replace(/:00(?=[+-]\d\d:\d\d$)/,'');
      tools.append(action('Download CSV',()=>{
        const decimals=(row,key)=>!classified && ['regular','overtime'].includes(key)?'':(row[key]/3600).toFixed(4);
        const header=[...dimensions.map(label=>t(label)),...keys.map(key=>t(columns[key])+' ('+t('hours')+')')];
        const blob=new Blob(['\uFEFF'+csv([header,...sorted.map(row=>[...detail(row),...keys.map(key=>decimals(row,key))])])],{type:'text/csv;charset=utf-8'});
        const url=URL.createObjectURL(blob), link=node('a');link.href=url;
        link.download=state.kind+'-'+state.start+'-'+state.end+'.csv';host.append(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      }),action('Print / Save PDF',()=>{
        const closed=[...output.querySelectorAll('details:not([open])')]; closed.forEach(item=>item.open=true);
        window.addEventListener('afterprint',()=>closed.forEach(item=>item.open=false),{once:true});window.print();
      })); output.append(tools);
      for (const [,items] of groups(sorted,'member')) {
        const section=node('details',null,'card scheduler-report-detail'), personTotals=sum(items);
        section.append(node('summary',name(items[0])+' · '+hours(personTotals.paid)));
        const scroll=node('div',null,'table-scroll'), table=node('table');
        const head=table.createTHead().insertRow(), body=table.createTBody();
        for (const label of [t('Date'),t('Job'),t('Clock in'),t('Clock out'),...keys.map(key=>t(columns[key]))]) head.append(node('th',label));
        for (const [day,dayRows] of groups(items,'day')) {
          const total=sum(dayRows), daily=body.insertRow();daily.className='scheduler-report-day';
          for (const value of [day,t('Daily total'),'','',...keys.map(key=>display(key,total[key]))]) daily.append(node('th',value));
          for (const row of dayRows) {
            const tr=body.insertRow();
            for (const value of [day,jobLabel(row),clock(row.clock_in),clock(row.clock_out),...keys.map(key=>display(key,row[key]))]) tr.append(node('td',value));
          }
        }
        scroll.append(table);section.append(scroll);output.append(section);
      }
    }
    host.append(modes,title,filters,announcement,output); root.append(host); draw(); void load();
  }
  window.ClassifireSchedulerReports={render};
})();
