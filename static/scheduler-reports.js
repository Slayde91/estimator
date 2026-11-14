(() => {
  'use strict';
  const columns = {elapsed:'Clocked time',paid:'Paid time',regular:'Regular',overtime:'Overtime / penalty',
    paid_break:'Paid breaks',unpaid_break:'Unpaid breaks'};
  const keys = Object.keys(columns);
  const hours = seconds => {
    const minutes = Math.round(seconds / 60);
    return Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'m';
  };
  // The report API already supplies local calendar dates and clock offsets.
  function reportDate(iso) {
    return iso ? iso.slice(8,10)+':'+iso.slice(5,7)+':'+iso.slice(2,4) : '';
  }
  function reportClock(instant,compact=false) {
    const time=instant.slice(11);
    return reportDate(instant)+' '+(compact?time.replace(/:00(?=[+-]\d\d:\d\d$)/,''):time);
  }
  function node(tag,text,cls) {
    const item=document.createElement(tag);
    if (text != null) item.textContent=text;
    if (cls) item.className=cls;
    return item;
  }
  function sum(rows) {
    const totals=Object.fromEntries(keys.map(key=>[key,0]));
    totals.overtime_by_rule=Object.create(null);
    for (const row of rows) {
      for (const key of keys) totals[key]+=row[key];
      for (const [id,seconds] of Object.entries(row.overtime_by_rule || {})) {
        totals.overtime_by_rule[id]=(totals.overtime_by_rule[id] || 0)+seconds;
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
    const period=control('Reporting period');
    function dateField(label,initial) {
      const field=node('div',null,'field'), caption=node('label',t(label));
      const controls=node('div',null,'scheduler-report-date'), text=node('input'), picker=node('input');
      text.id=label==='Start date'?'scheduler-report-start':'scheduler-report-end';
      caption.htmlFor=text.id; text.required=true; text.placeholder='DD:MM:YY'; text.maxLength=8;
      text.pattern='[0-9]{2}:[0-9]{2}:[0-9]{2}'; text.title=t('Enter a date as DD:MM:YY.');
      picker.type='date'; picker.min='2000-01-01'; picker.max='2100-12-31';
      picker.setAttribute('aria-label',t('Choose {0}',[t(label)]));
      const icon=svgNode('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':2,'aria-hidden':true,class:'scheduler-report-calendar'});
      icon.append(svgNode('rect',{x:3,y:5,width:18,height:16,rx:2}),
        svgNode('path',{d:'M3 10h18M8 3v4m8-4v4'}));
      const set=value=>{picker.value=value; text.value=reportDate(value); text.setCustomValidity('');};
      set(initial);
      text.addEventListener('input',()=>{
        // Keep a native selection of 2100 intact until its displayed date changes.
        if (text.value!==reportDate(picker.value)) {
          const match=/^(\d{2}):(\d{2}):(\d{2})$/.exec(text.value);
          picker.value=match?'20'+match[3]+'-'+match[2]+'-'+match[1]:'';
        }
        text.setCustomValidity(text.value && !picker.value?t('Enter a date as DD:MM:YY.'):'');
        invalidate();
      });
      text.addEventListener('change',()=>{if (picker.value) picker.dispatchEvent(new Event('change'));});
      picker.addEventListener('change',()=>set(picker.value));
      controls.append(text,icon,picker);field.append(caption,controls);filters.append(field);
      return {picker,set};
    }
    const startDate=dateField('Start date',state.start), endDate=dateField('End date',state.end);
    const start=startDate.picker, end=endDate.picker;
    for (const [id,label] of [['week','Week'],['month','Month'],['custom','Custom']]) period.add(new Option(t(label),id));
    period.value=state.period;
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
        startDate.set(weekStart(start.value)); endDate.set(addDays(start.value,6));
      } else {
        const current=new Date(start.value+'T12:00:00Z');
        startDate.set(start.value.slice(0,7)+'-01');
        endDate.set(new Date(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()+1,0,12)).toISOString().slice(0,10));
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
      // Metrics use the rule object itself, so even custom IDs such as "paid" remain distinct.
      const rules=data.overtime_rules.filter(rule=>totals.overtime_by_rule[rule.id]>0);
      const ruleLabel=rule=>rule.name+' ('+rule.multiplier+'×)';
      const labelCounts=new Map();
      for (const rule of rules) labelCounts.set(ruleLabel(rule),(labelCounts.get(ruleLabel(rule)) || 0)+1);
      const metricLabel=key=>{
        if (typeof key==='string') return t(columns[key]);
        const label=ruleLabel(key);
        return labelCounts.get(label)>1?label+' ['+key.id+']':label;
      };
      const seconds=(row,key)=>typeof key==='string'?row[key]:(Object.hasOwn(row.overtime_by_rule,key.id)?row.overtime_by_rule[key.id]:0);
      const classifiedField=key=>['regular','overtime'].includes(key) || typeof key==='object';
      const display=(row,key)=>!classified && classifiedField(key)?'—':hours(seconds(row,key));
      const decimals=new Intl.NumberFormat(document.documentElement.lang || 'en',{minimumFractionDigits:2,maximumFractionDigits:2});
      const numericHours=(row,key)=>!classified && classifiedField(key)?'—':decimals.format(seconds(row,key)/3600);
      const metricClass=key=>'scheduler-pay-value pay-'+(typeof key==='string'?key:'rule');
      const summaryLabel=key=>key==='paid'?t('Total paid hours'):key==='overtime'?t('Total overtime'):metricLabel(key);
      const detailKeys=['elapsed','paid','regular','overtime',...rules,'paid_break','unpaid_break'];
      const scope=[reportDate(state.start)+' – '+reportDate(state.end),data.timezone];
      for(const select of [member,project,job]) if(select.value) scope.push(select.selectedOptions[0].textContent);
      output.append(node('p',scope.join(' · '),'helper'));
      if (!rows.length) {output.append(node('p',t('No completed time entries match these filters.'),'notice'));return;}
      const payrollFields=[['regular'],['overtime'],rules,['paid'],['paid_break','unpaid_break']];
      if (payroll) {
        const summary=node('table',null,'scheduler-payroll-totals');
        summary.setAttribute('aria-label',t('Payroll hours'));
        const summaryRow=summary.createTBody().insertRow();
        for (const fields of payrollFields.filter(fields=>fields.length)) {
          const group=node('dl',null,'scheduler-pay-group');
          for (const key of fields) {
            const cell=node('div',null,metricClass(key));
            cell.title=summaryLabel(key)+' · '+display(totals,key);
            cell.append(node('dt',summaryLabel(key)),node('dd',numericHours(totals,key))); group.append(cell);
          }
          summaryRow.insertCell().append(group);
        }
        const overview=node('div',null,'scheduler-payroll-overview');
        overview.append(summary);
        if (classified) {
          const values=['regular','overtime'].map(key=>({label:metricLabel(key),seconds:totals[key]}));
          overview.append(pieChart(t('Regular vs overtime'),values,t,['#37845b','#c64156']));
        }
        output.append(overview);
      } else {
        const summary=node('dl',null,'scheduler-report-totals');
        for (const key of ['paid','paid_break','unpaid_break']) {
          const tile=node('div',null,'card');
          tile.append(node('dt',metricLabel(key)),node('dd',display(totals,key))); summary.append(tile);
        }
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
      const detail=row=>[reportDate(row.day),name(row),projectLabel(row),jobLabel(row),reportClock(row.clock_in),reportClock(row.clock_out)];
      tools.append(action('Download CSV',()=>{
        const decimals=(row,key)=>!classified && classifiedField(key)?'':(seconds(row,key)/3600).toFixed(4);
        const csvKeys=[...keys,...rules];
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
        const heading=node('summary');
        const memberLabel=node('span',payroll?name(items[0]):name(items[0])+' · '+hours(personTotals.paid),'scheduler-report-member');
        heading.append(memberLabel);
        if (payroll) {
          const breakdown=node('span',null,'scheduler-member-rates');
          for (const key of payrollFields.flat()) {
            if (typeof key==='object' && !seconds(personTotals,key)) continue;
            const chip=node('span',numericHours(personTotals,key),metricClass(key));
            chip.tabIndex=0; chip.setAttribute('role','img');
            const label=summaryLabel(key)+' · '+display(personTotals,key);
            chip.title=label; chip.setAttribute('aria-label',label); breakdown.append(chip);
          }
          heading.append(breakdown);
        }
        section.append(heading);
        // Repeat identifiers for long rule lists to keep each printed table readable.
        const tableKeys=rules.length<=3?[detailKeys]:[keys];
        if (rules.length>3) {
          for (let offset=0;offset<rules.length;offset+=5) tableKeys.push(rules.slice(offset,offset+5));
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
            for (const value of [reportDate(day),t('Daily total'),'','',...metrics.map(key=>display(total,key))]) daily.append(node('td',value));
            for (const row of entries) {
              const tr=body.insertRow();
              for (const value of [reportDate(day),jobLabel(row),reportClock(row.clock_in,true),reportClock(row.clock_out,true),...metrics.map(key=>display(row,key))]) tr.append(node('td',value));
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
