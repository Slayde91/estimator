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
    const totals=Object.fromEntries(keys.map(key=>[key,0]));
    totals.overtime_by_rate={};
    for (const row of rows) {
      for (const key of keys) totals[key]+=row[key];
      for (const [rate,seconds] of Object.entries(row.overtime_by_rate || {})) {
        totals.overtime_by_rate[rate]=(totals.overtime_by_rate[rate] || 0)+seconds;
      }
    }
    return totals;
  }
  function groups(rows,key) {
    const result=new Map();
    for (const row of rows) {
      if (!result.has(row[key])) result.set(row[key],[]);
      result.get(row[key]).push(row);
    }
    return result;
  }
  function groupedHours(rows,key,label) {
    return Array.from(groups(rows,key).values(),items=>({
      label:label(items[0]), seconds:items.reduce((total,row)=>total+row.paid,0)
    })).sort((a,b)=>b.seconds-a.seconds || a.label.localeCompare(b.label));
  }
  function svgNode(tag,attributes) {
    const item=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for (const [key,value] of Object.entries(attributes)) item.setAttribute(key,value);
    return item;
  }
  const projectColors=['#cf4656','#098377','#cc771c','#415fa9','#8464a6','#468443','#b45a8e','#567488'];
  function pieChart(title,values,t,colors=projectColors) {
    const section=node('section',null,'card scheduler-report-chart');
    section.append(node('h3',title));
    const total=values.reduce((seconds,item)=>seconds+item.seconds,0);
    const graphic=svgNode('svg',{viewBox:'-102 -102 204 204',role:'img','aria-label':title,class:'scheduler-report-pie'});
    const legend=node('ul',null,'scheduler-report-legend');
    const percent=new Intl.NumberFormat(document.documentElement.lang || 'en',{style:'percent',maximumFractionDigits:1});
    let elapsed=0;
    const point=fraction=>{
      const angle=(fraction*2-0.5)*Math.PI;
      return [Math.cos(angle)*100,Math.sin(angle)*100];
    };
    for (const [index,item] of values.entries()) {
      const color=colors[index%colors.length], share=total?item.seconds/total:0;
      if (share>0) {
        const start=elapsed/total, end=(elapsed+item.seconds)/total;
        const slice=share===1?svgNode('circle',{r:100,fill:color}):svgNode('path',{
          d:`M0 0 L${point(start)} A100 100 0 ${share>0.5?1:0} 1 ${point(end)} Z`,fill:color
        });
        const tooltip=svgNode('title',{});
        tooltip.textContent=item.label+' · '+percent.format(share)+' · '+hours(item.seconds);
        slice.append(tooltip); graphic.append(slice);
        if (share>=0.075) {
          const [x,y]=share===1?[0,0]:point((start+end)/2);
          const label=svgNode('text',{x:x*0.68,y:y*0.68,'text-anchor':'middle','dominant-baseline':'central'});
          label.textContent=percent.format(share); graphic.append(label);
        }
      }
      elapsed+=item.seconds;
      const line=node('li'), swatch=svgNode('svg',{viewBox:'0 0 10 10','aria-hidden':true});
      swatch.append(svgNode('circle',{cx:5,cy:5,r:5,fill:color}));
      line.append(swatch,node('span',item.label),node('span',total?percent.format(share):'—'),
        node('strong',hours(item.seconds))); legend.append(line);
    }
    if (total) section.append(graphic);
    else section.append(node('p',t('No paid time'),'helper'));
    const footer=node('div',null,'scheduler-chart-total');
    footer.append(node('span',t('Total')),node('strong',hours(total)));
    section.append(legend,footer);
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
      const rates=Object.keys(totals.overtime_by_rate).sort((a,b)=>Number(a)-Number(b));
      const metricLabel=key=>columns[key]?t(columns[key]):t('{0}× overtime / penalty',[key]);
      const seconds=(row,key)=>columns[key]?row[key]:(row.overtime_by_rate?.[key] || 0);
      const classifiedField=key=>['regular','overtime'].includes(key) || !columns[key];
      const display=(row,key)=>!classified && classifiedField(key)?'—':hours(seconds(row,key));
      const detailKeys=['elapsed','paid','regular','overtime',...rates,'paid_break','unpaid_break'];
      const scope=[state.start+' – '+state.end,data.timezone];
      for(const select of [member,project,job]) if(select.value) scope.push(select.selectedOptions[0].textContent);
      output.append(node('p',scope.join(' · '),'helper'));
      if (!rows.length) {output.append(node('p',t('No completed time entries match these filters.'),'notice'));return;}
      const fields=payroll?['paid','regular','overtime',...rates,'paid_break','unpaid_break']:['paid','paid_break','unpaid_break'];
      const summary=node('dl',null,'scheduler-report-totals');
      for (const key of fields) {
        const tile=node('div',null,columns[key]?'card':'card scheduler-rate-total');
        tile.append(node('dt',metricLabel(key)),node('dd',display(totals,key))); summary.append(tile);
      }
      if (payroll && classified) {
        const overview=node('div',null,'scheduler-payroll-overview');
        const values=['regular','overtime'].map(key=>({label:metricLabel(key),seconds:totals[key]}));
        overview.append(summary,pieChart(t('Regular vs overtime'),values,t,['#37845b','#c64156']));
        output.append(overview);
      } else {
        output.append(summary);
      }
      if (payroll && !classified) output.append(node('p',t('Confirm pay rules before calculating pay.'),'helper'));
      for (const message of data.warnings) output.append(node('p',message,'helper'));
      if (!payroll) {
        const charts=node('div',null,'scheduler-report-charts');
        charts.append(pieChart(t('Jobs'),groupedHours(rows,'job',jobLabel),t),
          pieChart(t('Projects'),groupedHours(rows,'project',projectLabel),t),
          pieChart(t('Team members'),groupedHours(rows,'member',name),t));
        output.append(charts);
      }
      const tools=node('div',null,'scheduler-report-tools');
      const dimensions=['Date','Team member','Project','Job','Clock in','Clock out'];
      const sorted=rows.slice().sort((a,b)=>name(a).localeCompare(name(b))||a.day.localeCompare(b.day)||Date.parse(a.clock_in)-Date.parse(b.clock_in));
      const detail=row=>[row.day,name(row),projectLabel(row),jobLabel(row),row.clock_in,row.clock_out];
      const clock=instant=>instant.replace('T',' ').replace(/:00(?=[+-]\d\d:\d\d$)/,'');
      tools.append(action('Download CSV',()=>{
        const decimals=(row,key)=>!classified && classifiedField(key)?'':(seconds(row,key)/3600).toFixed(4);
        // Keep existing CSV columns in place for saved imports and append the applied rates.
        const csvKeys=[...keys,...rates];
        const header=[...dimensions.map(label=>t(label)),...csvKeys.map(key=>metricLabel(key)+' ('+t('hours')+')')];
        const blob=new Blob(['\uFEFF'+csv([header,...sorted.map(row=>[...detail(row),...csvKeys.map(key=>decimals(row,key))])])],{type:'text/csv;charset=utf-8'});
        const url=URL.createObjectURL(blob), link=node('a');link.href=url;
        link.download=state.kind+'-'+state.start+'-'+state.end+'.csv';host.append(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      }),action('Print / Save PDF',()=>{
        const closed=[...output.querySelectorAll('details:not([open])')]; closed.forEach(item=>item.open=true);
        window.addEventListener('afterprint',()=>closed.forEach(item=>item.open=false),{once:true});window.print();
      })); output.append(tools);
      for (const [,items] of groups(sorted,'member')) {
        const section=node('details',null,'card scheduler-report-detail'), personTotals=sum(items);
        const heading=node('summary',name(items[0])+' · '+hours(personTotals.paid));
        if (payroll && classified) {
          const breakdown=node('span',null,'scheduler-member-rates');
          for (const key of ['regular','overtime',...rates.filter(rate=>seconds(personTotals,rate)>0)]) {
            breakdown.append(node('span',metricLabel(key)+' · '+display(personTotals,key)));
          }
          heading.append(breakdown);
        }
        section.append(heading);
        // For many distinct rates, repeat row identifiers in manageable tables that also fit a printed page.
        const tableKeys=rates.length<=3?[detailKeys]:[keys];
        if (rates.length>3) {
          for (let offset=0;offset<rates.length;offset+=5) tableKeys.push(rates.slice(offset,offset+5));
        }
        const days=Array.from(groups(items,'day'),([day,entries])=>({day,entries,total:sum(entries)}));
        for (const metrics of tableKeys) {
          const scroll=node('div',null,'table-scroll'), table=node('table');
          if (tableKeys.length>1) table.createCaption().textContent=t(metrics===keys?'Paid time':'Overtime / penalty');
          const head=table.createTHead().insertRow(), body=table.createTBody();
          for (const label of [t('Date'),t('Job'),t('Clock in'),t('Clock out'),...metrics.map(metricLabel)]) {
            const header=node('th',label); header.scope='col'; head.append(header);
          }
          for (const {day,entries,total} of days) {
            const daily=body.insertRow(); daily.className='scheduler-report-day';
            for (const value of [day,t('Daily total'),'','',...metrics.map(key=>display(total,key))]) daily.append(node('td',value));
            for (const row of entries) {
              const tr=body.insertRow();
              for (const value of [day,jobLabel(row),clock(row.clock_in),clock(row.clock_out),...metrics.map(key=>display(row,key))]) tr.append(node('td',value));
            }
          }
          scroll.append(table); section.append(scroll);
        }
        output.append(section);
      }
    }
    host.append(modes,title,filters,announcement,output); root.append(host); draw(); void load();
  }
  window.ClassifireSchedulerReports={render};
})();
