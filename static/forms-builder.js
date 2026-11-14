(() => {
  'use strict';

  const palette = {
    'Text and layout': [
      ['text', 'Single line text'], ['textarea', 'Multi-line text'], ['number', 'Number'],
      ['instruction', 'Prefilled text'], ['section', 'Section heading'], ['page_break', 'Page break'],
    ],
    'Date and time': [
      ['date', 'Date'], ['datetime', 'Date and time'], ['date_range', 'Date range'],
      ['datetime_range', 'Date and time range'], ['expiry_date', 'Expiry date'],
    ],
    'Choices and people': [
      ['choice', 'Dropdown list'], ['multichoice', 'Multiple choice'], ['yes_no', 'Yes / No / N/A'],
      ['person', 'Person'], ['profile_name', 'Full name'], ['profile_company', 'Company'], ['profile_phone', 'Phone'],
      ['lookup', 'Form reference'], ['relationship', 'Relationship'],
    ],
    'Tables and groups': [
      ['table', 'Table'], ['prefilled_table', 'Prefilled table'], ['group', 'Repeating group'],
      ['sign_on_table', 'Staff sign-on table'], ['weather_table', 'Weather table'],
    ],
    'Evidence and sign-off': [
      ['attachment', 'Attachment'], ['photo', 'Photo / video'], ['sketch', 'Sketch'],
      ['location', 'Location'], ['signature', 'Signature'], ['manual_signature', 'Manual signature'], ['signatures', 'Multiple signatures'],
      ['approval', 'Approval signature'], ['action', 'Action'], ['counter', 'Form counter'],
      ['scan_id', 'Verify staff ID'], ['staff_wallet', 'Staff identity wallet'], ['id_text', 'ID (manual entry)'],
      ['weather', 'Weather observation'],
    ],
  };
  const names = new Map(Object.values(palette).flat());
  const columnNames = new Map([...names, ['formula', 'Formula'], ['list_property', 'List property'], ['time', 'Time']]);
  const columnTypes = ['text', 'textarea', 'instruction', 'number', 'date', 'datetime', 'time', 'choice', 'list_property',
    'multichoice', 'yes_no', 'person', 'attachment', 'photo', 'signature', 'manual_signature', 'location', 'formula'];
  const presets = new Set(['prefilled_table', 'sign_on_table', 'weather_table', 'signatures']);
  const fieldTypes = [...names.keys()].filter(k => !presets.has(k));
  const groupTypes = fieldTypes.filter(type => !['table','group','page_break','section','counter','approval'].includes(type));
  const layoutTypes = new Set(['instruction', 'section', 'page_break', 'counter']);
  const choiceTypes = new Set(['choice', 'multichoice']);
  const defaultTypes = new Set(['text', 'textarea', 'number', 'choice', 'multichoice', 'yes_no']);
  const thumbnailTypes = new Set(['text', 'choice', 'date', 'datetime', 'expiry_date', 'counter']);
  const registerCellTypes = new Set(['text','textarea','number','date','datetime','time','choice','multichoice','yes_no','list_property','formula']);
  const roleNames = {viewer: 'Viewer', editor: 'Editor', admin: 'Administrator'};
  const tabNames = {fields: 'Fields', defaults: 'Default values', settings: 'Settings', raw: 'Field JSON'};
  const dragType = 'application/x-classifire-form-field';
  const fieldId = () => crypto.randomUUID();
  const clone = value => structuredClone(value);
  const copy = (key, args = []) => window.CeasefireI18n?.translate(key, args) ?? key;
  function node(tag, cls, content) {
    const out = document.createElement(tag);
    if (cls) out.className = cls;
    if (content !== undefined) out.textContent = content;
    return out;
  }
  function ui(tag, cls, label) {
    const out = node(tag, cls, label);
    window.CeasefireI18n?.text(out, label);
    return out;
  }
  function button(label, click, cls = 'button secondary') {
    const out = ui('button', cls, label);
    out.type = 'button';
    out.addEventListener('click', click);
    return out;
  }
  let controlNumber = 0;
  function labelled(label, input, literal = false) {
    const single = input.matches('input,select,textarea');
    const wrap = node(single ? 'label' : 'div', 'field form-builder-control');
    const caption = literal ? node('span','',label) : ui('span','',label);
    caption.id = 'form-builder-caption-' + (++controlNumber);
    if (!single) input.setAttribute('role','group');
    input.setAttribute('aria-labelledby', caption.id);
    wrap.append(caption, input);
    return wrap;
  }
  function input(value, update, type = 'text') {
    const control = node(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') control.type = type;
    control.value = value ?? '';
    control.addEventListener('input', () => update(control.value));
    return control;
  }
  function select(value, choices, update) {
    const control = node('select');
    for (const [key, label] of choices) control.add(new Option(label, key));
    control.value = value ?? '';
    control.addEventListener('change', () => update(control.value));
    return control;
  }
  function check(label, checked, update, literal = false) {
    const wrap = node('label', 'form-builder-check'), control = node('input');
    control.type = 'checkbox'; control.checked = checked;
    control.addEventListener('change', () => update(control.checked));
    wrap.append(control, literal ? node('span','',label) : ui('span', '', label)); return wrap;
  }
  const typeChoices = types => types.map(type => [type, copy(columnNames.get(type))]);
  const yesNoOptions = ['Yes', 'No', 'N/A'];
  const actionStatuses = ['Pending','In progress','Completed','Cancelled'];
  const valuesFor = f => f.options || (f.type === 'yes_no' ? yesNoOptions : []);
  const photoSizes = () => [['xs',copy('Extra small')],['small',copy('Small')],['medium',copy('Medium')],['large',copy('Large')],['xl',copy('Extra large')]];
  function newField(type) {
    if (presets.has(type)) {
      const table = ['weather_table','prefilled_table'].includes(type);
      const field = newField(table ? 'table' : 'group');
      field.label = copy(names.get(type));
      if (type === 'prefilled_table') { field.table_mode = 'fixed'; field.default = [{}]; }
      if (type === 'weather_table') field.columns = [
        ['datetime','Observation time'], ['text','Conditions'], ['number','Temperature (°C)'], ['number','Wind (km/h)'],
      ].map(([kind,label]) => ({...newField(kind),label:copy(label)}));
      if (type === 'signatures') field.children = [newField('person'),newField('manual_signature')];
      if (type === 'sign_on_table') field.children = [newField('scan_id'), newField('datetime'), newField('manual_signature')];
      return field;
    }
    const field = {id: fieldId(), type, label: copy(columnNames.get(type))};
    if (choiceTypes.has(type)) field.options = [copy('Option 1'), copy('Option 2')];
    if (type === 'table') field.columns = [newField('text')];
    if (type === 'group') field.children = [newField('text')];
    return field;
  }
  function baseTemplate(source) {
    return {id: fieldId(), version: 0, name: '', description: '', status: 'draft',
      roles: ['admin', 'editor'], mode: 'timeline', fields: [], ...clone(source || {}),
      settings: {orientation: 'portrait', summary_fields: [], summary_cells: [], sort_field: '', stages: [], ...clone(source?.settings || {})}};
  }
  function mount(host, source, {onSave, onCancel, onPreview, onOutline, staff = []}) {
    let model = baseTemplate(source), baseline = JSON.stringify(model);
    let active = model.fields[0]?.id, tab = 'fields', search = '', busy = false, dragging = null;
    let raw = '', rawChanged = false, error = '';
    let history = [baseline], historyIndex = 0;
    const shell = node('section', 'form-builder'), nav = node('nav', 'form-builder-tabs');
    nav.setAttribute('aria-label', copy('Template editor'));
    const header = node('header', 'form-builder-header'), title = ui('h2', '', 'Template editor');
    const actions = node('div', 'form-builder-actions'), body = node('div', 'form-builder-body');
    const message = node('p', 'form-builder-message'); message.setAttribute('role', 'status'); message.hidden = true;
    const nameControl = input(model.name, name => { model.name = name; }); nameControl.maxLength = 160;
    nameControl.placeholder = copy('Template name');
    header.append(title, labelled('Template name', nameControl), actions);
    shell.append(header, nav, message, body);
    host.replaceChildren(shell);
    const dirty = () => rawChanged || JSON.stringify(model) !== baseline;
    function remember() {
      if (busy) return;
      const snapshot = JSON.stringify(model);
      if (snapshot === history[historyIndex]) return;
      history.splice(historyIndex + 1);
      history.push(snapshot);
      if (history.length > 40) history.shift();
      historyIndex = history.length - 1;
      updateHistoryButtons();
    }
    function restore(direction) {
      if (busy || !applyRaw()) return;
      remember();
      const index = historyIndex + direction;
      if (index < 0 || index >= history.length) return;
      historyIndex = index; model = JSON.parse(history[index]);
      active = model.fields.some(f => f.id === active) ? active : model.fields[0]?.id;
      nameControl.value = model.name;
      updateHeader(); show(tab);
    }
    function updateHistoryButtons() {
      actions.querySelector('[data-history="undo"]').disabled = busy || !historyIndex;
      actions.querySelector('[data-history="redo"]').disabled = busy || historyIndex >= history.length - 1;
    }
    shell.addEventListener('change', remember);
    shell.addEventListener('click', e => {
      if (e.target.closest('button') && !e.target.closest('[data-history]')) remember();
    });
    shell.addEventListener('drop', remember);
    function notify(value, failed = false) {
      error = failed ? value : '';
      message.textContent = value; message.hidden = !value;
      message.classList.toggle('error', failed);
      message.setAttribute('role', failed ? 'alert' : 'status');
    }
    function updateHeader() {
      actions.replaceChildren(button('Back', () => {
        if (!busy && (!dirty() || window.confirm(copy('Discard unsaved template changes?')))) onCancel();
      }));
      for (const [label, direction] of [['Undo', -1], ['Redo', 1]]) {
        const undo = button(label, () => restore(direction)); undo.dataset.history = label.toLowerCase(); actions.append(undo);
      }
      actions.append(button('Preview', () => {
        if (applyRaw()) onPreview(clone(model));
      }));
      const saveLabel = model.status === 'published' ? 'Save changes' : 'Save draft';
      actions.append(button(saveLabel, () => save(model.status === 'published' ? 'published' : 'draft'), 'button primary'));
      if (model.status !== 'published') actions.append(button('Publish', () => save('published'), 'button primary'));
      for (const item of actions.children) item.disabled = busy;
      updateHistoryButtons();
      nameControl.disabled = busy;
      nav.inert = busy; body.inert = busy;
    }
    function validateFields(fields, publishing = false) {
      const ids = new Set(), top = new Map();
      function validateField(field, types, previous) {
        if (!field || typeof field !== 'object' || !types.includes(field.type)) throw Error(copy('Choose a supported field type.'));
        if (typeof field.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(field.id) ||
            ['constructor','prototype','__proto__'].includes(field.id) || ids.has(field.id)) throw Error(copy('Every field needs a unique ID.'));
        ids.add(field.id);
        if (typeof field.label !== 'string' || !field.label.trim()) throw Error(copy('Enter a label for each field.'));
        if (field.label.length > 250 || (field.help !== undefined && (typeof field.help !== 'string' || field.help.length > 5000)))
          throw Error(copy('Use up to 250 characters for field labels and 5,000 for help text.'));
        if ((choiceTypes.has(field.type) || (field.type === 'yes_no' && field.options !== undefined)) && (!Array.isArray(field.options) || (publishing && !field.options.length) ||
            field.options.length > 500 || field.options.some(opt => typeof opt !== 'string' || opt.length > 500 || !opt.trim()) || new Set(field.options).size !== field.options.length))
          throw Error(copy('List choices must be filled in and unique.'));
        if (field.condition) {
          const trigger = previous.get(field.condition.field_id);
          if (!trigger || !(choiceTypes.has(trigger.type) || trigger.type === 'yes_no') ||
              !valuesFor(trigger).includes(field.condition.value)) throw Error(copy('Choose an earlier question and an existing answer for each condition.'));
        }
        if (field.type === 'yes_no' && (!valuesFor(field).every(v => yesNoOptions.includes(v)) ||
          (field.explanation_on !== undefined && (!Array.isArray(field.explanation_on) || !field.explanation_on.every(v => valuesFor(field).includes(v))))))
          throw Error(copy('Choose an available answer for each explanation.'));
        if (field.reminder_days !== undefined && !(Number.isInteger(field.reminder_days) && field.reminder_days >= 0 && field.reminder_days <= 365))
          throw Error(copy('Choose a whole number of reminder days between 0 and 365.'));
        if (field.type === 'table' || field.type === 'group') {
          const table = field.type === 'table', children = table ? field.columns : field.children;
          if (!Array.isArray(children) || (publishing && !children.length)) throw Error(copy('Add at least one column or child field.'));
          const siblings = new Map();
          for (const child of children) {
            validateField(child, table ? columnTypes : groupTypes, siblings); siblings.set(child.id, child);
          }
          if (table && field.default !== undefined && (!Array.isArray(field.default) || field.default.length > 500 ||
              field.default.some(row => !row || typeof row !== 'object' || Array.isArray(row))))
            throw Error(copy('Prefilled table rows must be a list of records.'));
          if (publishing && table && field.table_mode === 'fixed' && !field.default?.length)
            throw Error(copy('Add a prefilled row in Default values for each fixed table.'));
          if (table) children.forEach((col,i) => {
            if (col.type === 'list_property') {
              const source = children.slice(0,i).find(c => c.type === 'choice' && c.id === col.source_column);
              if (((publishing || col.source_column) && !source) || (col.mapping && (typeof col.mapping !== 'object' || Array.isArray(col.mapping))))
                throw Error(copy('Choose a preceding list column for each list property.'));
            }
            if (publishing && col.type === 'formula' && (typeof col.formula !== 'string' || !col.formula.trim()))
              throw Error(copy('Enter an expression for each formula column.'));
          });
        }
        if (field.type === 'approval' && model.mode !== 'workflow') throw Error(copy('Approval signatures require a workflow template.'));
      }
      for (const field of fields) { validateField(field, fieldTypes, top); top.set(field.id, field); }
      if (ids.size > 500) throw Error(copy('A template can have up to 500 fields, including table columns and group fields.'));
    }
    function validTemplate(status) {
      if (!model.name.trim()) { nameControl.focus(); throw Error(copy('Enter a template name.')); }
      if (status !== 'draft' && !model.fields.length) throw Error(copy('Add a field before publishing.'));
      if (!model.roles.length) throw Error(copy('Choose at least one user type in Settings.'));
      if (model.mode === 'workflow' && (!model.settings.stages.length || model.settings.stages.some(s => !s.name.trim() || !s.roles.length)))
        throw Error(copy('Give each workflow stage a name and an authorised user type.'));
      if (model.mode === 'workflow') for (const [index, stage] of model.settings.stages.entries()) {
        const available = stageConditionFields(index);
        for (const rule of stage.approval_conditions || []) {
          const field = available.find(f => f.id === rule.field_id);
          if (!field || !conditionAnswers(field).includes(rule.value))
            throw Error(copy('Update the approval conditions for this stage') + ' · ' + stage.name);
        }
      }
      validateFields(model.fields, status === 'published');
    }
    async function save(status) {
      if (busy || !applyRaw()) return;
      try {
        validTemplate(status);
        busy = true; updateHeader(); notify(copy('Saving…'));
        const saved = await onSave({...clone(model), status});
        if (!shell.isConnected) return;
        model = baseTemplate(saved || {...model, status}); baseline = JSON.stringify(model);
        history = [baseline]; historyIndex = 0;
        nameControl.value = model.name;
        show(tab); notify(copy(status === 'published' ? 'Template published.' : 'Template saved.'));
      } catch (e) { notify(e.message, true); }
      finally { busy = false; updateHeader(); }
    }
    function applyRaw() {
      if (!rawChanged) return true;
      try {
        const fields = JSON.parse(raw);
        if (!Array.isArray(fields)) throw Error(copy('Field JSON must be an array.'));
        validateFields(fields);
        model.fields = fields;
        pruneRegisterCells();
        rawChanged = false; active = fields[0]?.id;
        return true;
      } catch (e) { notify(e.message, true); return false; }
    }
    function show(next) {
      if (!applyRaw()) return;
      tab = next; nav.replaceChildren();
      for (const [key, label] of Object.entries(tabNames)) {
        const entry = button(label, () => { if (key !== tab) show(key); }, 'calculator-page');
        entry.setAttribute('aria-pressed', String(key === tab)); nav.append(entry);
      }
      body.replaceChildren();
      if (next === 'fields') fieldsPage();
      else if (next === 'settings') settingsPage();
      else if (next === 'defaults') defaultsPage();
      else rawPage();
      if (error) notify('');
    }
    function rawPage() {
      raw = JSON.stringify(model.fields, null, 2); rawChanged = false;
      const json = input(raw, value => { raw = value; rawChanged = true; }, 'textarea');
      json.className = 'form-builder-json'; json.spellcheck = false; json.wrap = 'off';
      body.append(labelled('Field definitions (JSON)', json),
        button('Apply fields', () => { if (applyRaw()) show('fields'); }),
        button('Discard JSON edits', () => {
          if (rawChanged && !window.confirm(copy('Discard changes to the field definitions?'))) return;
          rawChanged = false; show('raw');
        }));
    }
    function fieldsPage() {
      const layout = node('div', 'form-builder-layout'), paletteHost = node('aside', 'form-builder-palette'),
        canvas = node('div', 'form-builder-canvas'), filter = input(search, value => { search = value; drawPalette(); }, 'search'),
        types = node('div', 'form-builder-types');
      filter.placeholder = copy('Search fields');
      paletteHost.append(labelled('Search fields', filter), types);
      if (onOutline) paletteHost.insertBefore(button('Add from outline', async () => {
        if (busy || !applyRaw()) return;
        busy = true; updateHeader();
        try {
          const incoming = await onOutline();
          if (!Array.isArray(incoming) || !incoming.length || !shell.isConnected) return;
          const fields = [...model.fields, ...clone(incoming)];
          validateFields(fields);
          model.fields = fields; active = incoming[0].id; drawCanvas(active);
        } catch (e) { notify(e.message, true); }
        finally { busy = false; updateHeader(); remember(); }
      }), types);
      canvas.setAttribute('aria-label', copy('Template fields'));
      function startDrag(e, item) {
        dragging = item; e.dataTransfer.effectAllowed = item.id ? 'move' : 'copy';
        e.dataTransfer.setData(dragType, JSON.stringify(item));
      }
      function drawPalette() {
        types.replaceChildren();
        for (const [group, entries] of Object.entries(palette)) {
          const section = node('div', 'form-builder-palette-group');
          section.append(ui('h3', '', group));
          for (const [type, label] of entries) {
            if (type === 'approval' && model.mode !== 'workflow') continue;
            if (!copy(label).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) continue;
            const item = button(label, event => {
              if (event.detail > 1) return;
              insert({type}, event.shiftKey ? 0 : model.fields.length);
            }, 'form-builder-palette-item');
            item.draggable = true; item.dataset.fieldType = type;
            item.addEventListener('dragstart', e => startDrag(e, {type}));
            section.append(item);
          }
          if (section.childElementCount > 1) types.append(section);
        }
        if (!types.childElementCount) types.append(ui('p', 'helper', 'No matching fields.'));
      }
      function dropAt(e, index) {
        if (!dragging || !e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault(); e.stopPropagation();
        const item = dragging; dragging = null; insert(item, index);
      }
      layout.addEventListener('dragend', () => { dragging = null; clearDrop(); });
      function clearDrop() { canvas.querySelectorAll('[data-drop]').forEach(el => el.removeAttribute('data-drop')); }
      canvas.addEventListener('dragover', e => {
        if (!dragging || !e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault(); e.dataTransfer.dropEffect = dragging.id ? 'move' : 'copy';
        const row = e.target.closest('[data-field-id]');
        clearDrop();
        if (row) row.dataset.drop = before(e, row) ? 'before' : 'after';
        else canvas.dataset.drop = 'end';
      });
      canvas.addEventListener('dragleave', e => { if (!canvas.contains(e.relatedTarget)) { clearDrop(); delete canvas.dataset.drop; } });
      canvas.addEventListener('drop', e => {
        const row = e.target.closest('[data-field-id]');
        delete canvas.dataset.drop;
        const index = row ? model.fields.findIndex(f => f.id === row.dataset.fieldId) + (before(e, row) ? 0 : 1) : model.fields.length;
        dropAt(e, index);
      });
      function before(e, row) { const box = row.getBoundingClientRect(); return e.clientY < box.top + box.height / 2; }
      function insert(item, index) {
        let field;
        if (item.id) {
          const previous = model.fields.findIndex(f => f.id === item.id);
          if (previous < 0) return;
          const order = [...model.fields];
          [field] = order.splice(previous, 1);
          order.splice(index > previous ? index - 1 : index, 0, field);
          if (!order.every((f, i) => !f.condition || order.slice(0,i).some(prev => prev.id === f.condition.field_id))) {
            notify(copy('Keep a conditional field after the question that controls it.'), true);
            clearDrop(); return;
          }
          model.fields = order;
        } else {
          field = newField(item.type); model.fields.splice(index, 0, field);
        }
        active = field.id; drawCanvas(field.id); remember();
      }
      function drawCanvas(focus) {
        canvas.replaceChildren();
        if (!model.fields.length) {
          const empty = node('div', 'form-builder-drop-empty');
          empty.append(ui('strong', '', 'Add your first field'), ui('span', 'helper', 'Drag a field here or choose one from the field list.'));
          canvas.append(empty);
        }
        for (const [i, f] of model.fields.entries()) {
          const row = node('article', 'form-builder-row'); row.dataset.fieldId = f.id;
          row.classList.toggle('selected', f.id === active);
          const rowHead = node('div', 'form-builder-row-head'), choose = node('button', 'form-builder-field-select');
          choose.type = 'button'; choose.draggable = true; choose.setAttribute('aria-expanded', String(f.id === active));
          const title = node('strong', '', f.label || copy(names.get(f.type)));
          choose.append(title, ui('small', '', names.get(f.type)));
          choose.addEventListener('click', () => { active = f.id === active ? null : f.id; drawCanvas(f.id); });
          choose.addEventListener('dragstart', e => startDrag(e, {id: f.id}));
          const tools = node('div', 'form-builder-row-tools');
          for (const [label, symbol, handler, disabled] of [
            ['Move up', '↑', () => insert({id:f.id}, i - 1), i === 0],
            ['Move down', '↓', () => insert({id:f.id}, i + 2), i === model.fields.length - 1],
            ['Duplicate field', '⧉', () => duplicate(f, i), false],
            ['Remove field', '×', () => remove(f, i), false],
          ]) {
            const tool = node('button', 'form-builder-tool', symbol); tool.type = 'button';
            tool.title = copy(label); tool.setAttribute('aria-label', copy(label)); tool.disabled = disabled;
            tool.addEventListener('click', handler); tools.append(tool);
          }
          rowHead.append(choose, tools); row.append(rowHead);
          if (f.id === active) renderField(row, f, i, title, () => drawCanvas());
          canvas.append(row);
        }
        if (focus) canvas.querySelector('[data-field-id="'+CSS.escape(focus)+'"] .form-builder-field-select')?.focus();
      }
      function duplicate(f, i) {
        const field = clone(f); field.id = fieldId();
        const children = field.columns || field.children || [];
        const remap = new Map(children.map(c => [c.id, fieldId()]));
        for (const child of children) {
          child.id = remap.get(child.id);
          if (child.condition && remap.has(child.condition.field_id)) child.condition.field_id = remap.get(child.condition.field_id);
          if (child.source_column && remap.has(child.source_column)) child.source_column = remap.get(child.source_column);
        }
        if (f.type === 'table' && Array.isArray(field.default))
          field.default = field.default.map(row => Object.fromEntries(Object.entries(row).map(([key,val]) => [remap.get(key), val])));
        model.fields.splice(i + 1, 0, field); active = field.id; drawCanvas(field.id);
      }
      function remove(f, i) {
        if (model.mode === 'workflow' && model.settings.stages.some(stage => stage.approval_conditions?.some(rule => rule.field_id === f.id))) {
          notify(copy('Remove this field from the approval conditions in Settings before deleting it.'), true); return;
        }
        if (!window.confirm(copy('Remove this field from the template?'))) return;
        model.fields.splice(i,1);
        for (const item of model.fields) if (item.condition?.field_id === f.id) delete item.condition;
        model.settings.summary_fields = model.settings.summary_fields.filter(id => id !== f.id);
        pruneRegisterCells();
        if (model.settings.sort_field === f.id) model.settings.sort_field = '';
        active = model.fields[Math.min(i, model.fields.length - 1)]?.id; drawCanvas(active);
      }
      drawPalette(); drawCanvas(); layout.append(paletteHost, canvas); body.append(layout);
    }

    function renderField(host, field, index, title, redraw) {
      const properties = node('div', 'form-builder-properties');
      const labelInput = input(field.label, value => {
        field.label = value; title.textContent = value || copy(names.get(field.type));
      });
      labelInput.maxLength = 250;
      const help = input(field.help, value => { field.help = value; }, 'textarea'); help.maxLength = 5000;
      properties.append(labelled('Field label', labelInput), labelled(field.type === 'instruction' ? 'Instructions' : 'Help text', help));
      if (!layoutTypes.has(field.type))
        properties.append(check('Required', Boolean(field.required), on => { field.required = on; }));
      properties.append(check('Hide in printed forms', Boolean(field.hide_in_pdf), on => { field.hide_in_pdf = on; }));
      if (model.mode === 'workflow' && model.settings.stages.length) {
        properties.append(labelled('Workflow stage', select(field.stage_id || '', [
          ['', copy('First stage')], ...model.settings.stages.map(s => [s.id, s.name]),
        ], value => { if (value) field.stage_id = value; else delete field.stage_id; })));
      }
      if (field.type === 'table' || field.type === 'group') nestedEditor(properties, field, redraw);
      if (choiceTypes.has(field.type)) optionEditor(properties, field);
      if (field.type === 'person') properties.append(check('Select multiple people', Boolean(field.multiple), on => { field.multiple = on; }));
      if (field.type === 'yes_no') yesNoEditor(properties, field, redraw);
      if (field.type === 'datetime' || field.type === 'datetime_range')
        properties.append(check('Include time zone', Boolean(field.timezone), value => { field.timezone = value; }));
      if (field.type === 'expiry_date') expiryReminder(properties, field);
      if (field.type === 'photo') photoSettings(properties,field,redraw);
      conditionEditor(properties, field, model.fields.slice(0, index), redraw);
      host.append(properties);
    }
    function photoSettings(host, field, redraw) {
      host.append(labelled('Photo size',select(field.photo_size || 'medium',photoSizes(),value=>{
        field.photo_size=value;
        if (!['large','xl'].includes(value)) { delete field.show_tags; delete field.show_description; }
        redraw();
      })));
      if (['large','xl'].includes(field.photo_size)) host.append(
        check('Show photo tags',Boolean(field.show_tags),on=>{ field.show_tags=on; }),
        check('Show photo description',Boolean(field.show_description),on=>{ field.show_description=on; }));
    }
    function expiryReminder(host, field) {
      const days = input(field.reminder_days, value => {
        if (!value) delete field.reminder_days; else field.reminder_days = Number(value);
      }, 'number');
      days.min = '0'; days.max = '365'; days.step = '1'; days.placeholder = copy('No reminder');
      host.append(labelled('Remind before expiry (days)', days));
    }
    function conditionEditor(host, field, prior, redraw) {
      const triggers = prior.filter(f => choiceTypes.has(f.type) || f.type === 'yes_no');
      if (triggers.length) {
        const condition = node('div', 'form-builder-condition');
        const trigger = triggers.find(f => f.id === field.condition?.field_id);
        condition.append(labelled('Show field when', select(trigger?.id || '', [
          ['', copy('Always show')], ...triggers.map(f => [f.id, f.label]),
        ], id => {
          const selected = triggers.find(f => f.id === id);
          if (selected) field.condition = {field_id: id, value: valuesFor(selected)[0]};
          else delete field.condition;
          redraw();
        })));
        if (trigger) condition.append(labelled('Answer is', select(field.condition.value,
          valuesFor(trigger).map(v => [v, v]), value => { field.condition.value = value; })));
        host.append(condition);
      }
    }
    function optionEditor(host, field, siblings = []) {
      host.append(labelled('List appearance', select(field.display || 'dropdown', [
        ['dropdown',copy('Dropdown')],['inline',copy('Buttons')],
      ], value => { field.display = value; })));
      const choices = input((field.options || []).join('\n'), value => {
        field.options = value.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
      }, 'textarea');
      choices.addEventListener('change', () => {
        for (const col of siblings.filter(child => child.source_column === field.id)) {
          col.mapping = Object.fromEntries(Object.entries(col.mapping || {}).filter(([option]) => field.options.includes(option)));
        }
      });
      host.append(labelled('Choices (one per line)', choices));
    }
    function yesNoEditor(host, field, redraw) {
      const choices = group('Available answers'), explanations = group('Require an explanation for');
      for (const value of yesNoOptions) {
        const available = valuesFor(field).includes(value);
        choices.append(check(value, available, on => {
          field.options = yesNoOptions.filter(v => v === value ? on : valuesFor(field).includes(v));
          field.explanation_on = (field.explanation_on || []).filter(v => field.options.includes(v));
          redraw();
        }));
        if (available) explanations.append(check(value, (field.explanation_on || []).includes(value), on => {
          field.explanation_on = updateSet(field.explanation_on || [], value, on);
        }));
      }
      host.append(choices, explanations);
    }
    function group(label) {
      const section = node('fieldset', 'form-builder-group'); section.append(ui('legend', '', label)); return section;
    }
    function updateSet(values, key, include) {
      return include ? [...new Set([...values, key])] : values.filter(v => v !== key);
    }
    function arrangeTools(list, index, redraw, remove) {
      const tools = node('div', 'form-builder-row-tools');
      const up = button('Move up', () => swap(-1)), down = button('Move down', () => swap(1));
      up.disabled = index === 0; down.disabled = index === list.length - 1;
      function swap(delta) {
        const to = index + delta;
        const moved = [...list]; [moved[index], moved[to]] = [moved[to], moved[index]];
        if (moved.some((f, i) => f.condition && !moved.slice(0,i).some(prev => prev.id === f.condition.field_id))) {
          notify(copy('Keep the question before its conditional field.'), true); return;
        }
        if (moved.some((f,i) => f.type === 'list_property' && f.source_column && !moved.slice(0,i).some(prev => prev.id === f.source_column))) {
          notify(copy('Keep the source list before its property column.'), true); return;
        }
        list.splice(0, list.length, ...moved); redraw();
      }
      tools.append(up, down, button('Remove', remove)); return tools;
    }
    function nestedEditor(host, field, redraw) {
      const table = field.type === 'table', list = table ? field.columns : field.children;
      const section = group(table ? 'Table columns' : 'Group fields');
      section.classList.add('form-builder-nested');
      if (table) section.append(node('p','helper',copy('Formula reference') + ' · Table' +
        (model.fields.filter(f => f.type === 'table').findIndex(f => f.id === field.id) + 1)),
        labelled('Table rows', select(field.table_mode || 'dynamic', [
        ['dynamic',copy('Add or remove rows when filling in')], ['fixed',copy('Fixed prefilled rows')],
      ], mode => {
        field.table_mode = mode;
        if (mode === 'fixed' && !field.default?.length) field.default = [{}];
        pruneRegisterCells();
      })));
      function clearCells(id) {
        if (table && Array.isArray(field.default)) for (const row of field.default) delete row[id];
      }
      list.forEach((child, index) => {
        const card = node('div', 'form-builder-nested-row');
        if (table) {
          let number = index + 1, letters = '';
          while (number > 0) {
            number -= 1; letters = String.fromCharCode(65 + number % 26) + letters; number = Math.floor(number/26);
          }
          card.append(node('strong','form-builder-column-reference',copy('Column') + ' ' + letters));
        }
        const caption = input(child.label, value => { child.label = value; }); caption.maxLength = 250;
        card.append(labelled(table ? 'Column heading' : 'Field label', caption),
          labelled('Type', select(child.type, typeChoices(table ? columnTypes : groupTypes), type => {
            const next = {...newField(type), id: child.id, label: child.label, required: Boolean(child.required)};
            if (table && type === 'attachment') next.accept = 'application/pdf';
            if (table && type === 'list_property') {
              next.source_column = list.slice(0,index).find(c => c.type === 'choice')?.id || '';
              next.mapping = {};
            }
            list[index] = next;
            pruneRegisterCells();
            clearCells(child.id); redraw();
          })));
        card.append(check('Hide in printed forms', Boolean(child.hide_in_pdf), on => { child.hide_in_pdf = on; }));
        if (table) {
          const widths = ['xs','s','m','l','xl','xxl','xxxl'].map(size => [size, size.toUpperCase()]);
          card.append(labelled('Column width', select(child.width || 'm', widths, width => { child.width = width; })));
          if (child.type === 'formula') {
            const formula = input(child.formula, value => { child.formula = value; });
            formula.placeholder = '=A1*B1'; formula.spellcheck = false;
            card.append(labelled('Formula',formula), ui('p','helper','Use column letters and row numbers. A1 follows the row, A$1 fixes it, and Table1!A1 references another table.'));
          }
          if (child.type === 'list_property') {
            const sources = list.slice(0,index).filter(c => c.type === 'choice');
            card.append(labelled('Source list column', select(child.source_column || '',
              [['',copy('Choose a list column')],...sources.map(c=>[c.id,c.label])], value => {
                child.source_column = value; child.mapping = {}; redraw();
              })));
            const source = sources.find(c => c.id === child.source_column);
            if (!sources.length) card.append(ui('p','helper','Add a dropdown column before the list property.'));
            if (source) for (const option of valuesFor(source)) {
              const value = Object.hasOwn(child.mapping || {},option) ? child.mapping[option] : '';
              card.append(labelled(option,input(value, v => {
                child.mapping = {...child.mapping,[option]:v};
              }),true));
            }
          }
          if (child.type === 'time')
            card.append(labelled('Time interval (minutes)', select(String(child.interval || 15),
              [1,5,10,15,30,60].map(m => [String(m),String(m)]), value => { child.interval = Number(value); })));
        }
        if (child.type === 'photo') photoSettings(card,child,redraw);
        if (child.type === 'expiry_date') expiryReminder(card, child);
        if (choiceTypes.has(child.type)) optionEditor(card, child, list);
        if (child.type === 'person') card.append(check('Select multiple people', Boolean(child.multiple), on => { child.multiple = on; }));
        if (child.type === 'instruction') card.append(labelled('Instructions', input(child.help, v => { child.help = v; }, 'textarea')));
        if (!layoutTypes.has(child.type) && !['formula','list_property'].includes(child.type))
          card.append(check('Required', Boolean(child.required), on => { child.required = on; }));
        conditionEditor(card, child, list.slice(0,index), redraw);
        card.append(arrangeTools(list, index, redraw, () => {
          if (!window.confirm(copy(table ? 'Remove this column and its prefilled values?' : 'Remove this field from the group?'))) return;
          clearCells(child.id); list.splice(index, 1);
          pruneRegisterCells();
          for (const sibling of list) {
            if (sibling.condition?.field_id === child.id) delete sibling.condition;
            if (sibling.source_column === child.id) { delete sibling.source_column; sibling.mapping = {}; }
          }
          redraw();
        }));
        section.append(card);
      });
      section.append(button(table ? 'Add column' : 'Add group field', () => { list.push(newField('text')); redraw(); }));
      host.append(section);
    }

    function defaultControl(field, value, update) {
      if (field.type === 'multichoice') {
        const choices = node('div', 'form-builder-checks');
        let current = Array.isArray(value) ? value : [];
        for (const v of valuesFor(field)) choices.append(check(v, current.includes(v), on => {
          current = updateSet(current, v, on); update(current.length ? current : undefined);
        },true));
        return choices;
      }
      if (field.type === 'choice' || field.type === 'yes_no')
        return select(value, [['', copy('No default')], ...valuesFor(field).map(v => [v, v])], v => update(v || undefined));
      const inputType = {number:'number', textarea:'textarea', date:'date', datetime:'datetime-local', time:'time'}[field.type] || 'text';
      const control = input(value, v => update(v === '' ? undefined : field.type === 'number' ? Number(v) : v), inputType);
      if (inputType === 'number') control.step = 'any';
      return control;
    }
    function tableDefaults(host, field) {
      const wrap = node('div', 'form-builder-table-scroll'), table = node('table');
      const head = table.createTHead().insertRow(), rows = table.createTBody();
      for (const col of field.columns) head.append(node('th', '', col.label));
      head.append(ui('th', '', 'Actions'));
      let previousOrder = [...(field.default || [])];
      const draw = () => {
        const records = field.default || [];
        if (previousOrder.some((record,index)=>records[index] !== record)) {
          model.settings.summary_cells = model.settings.summary_cells.flatMap(cell=>{
            if (cell.field_id !== field.id) return [cell];
            const row = records.indexOf(previousOrder[cell.row]);
            return row < 0 ? [] : [{...cell,row}];
          });
        }
        previousOrder = [...records];
        rows.replaceChildren();
        for (const [index, record] of (field.default || []).entries()) {
          const row = rows.insertRow();
          for (const col of field.columns) {
            const cell = row.insertCell();
            if (!(defaultTypes.has(col.type) || ['time','date','datetime'].includes(col.type))) { cell.textContent = '—'; continue; }
            const control = defaultControl(col, record[col.id], v => {
              if (v === undefined) delete record[col.id]; else record[col.id] = v;
            });
            control.setAttribute('aria-label', col.label); cell.append(control);
          }
          row.insertCell().append(arrangeTools(field.default, index, draw, () => { field.default.splice(index, 1); draw(); }));
        }
      };
      draw(); wrap.append(table);
      host.append(wrap, button('Add prefilled row', () => { (field.default ||= []).push({}); draw(); }));
    }
    function defaultsPage() {
      const panel = node('div', 'form-builder-defaults');
      let count = 0;
      for (const field of model.fields) {
        if (!(defaultTypes.has(field.type) || field.type === 'table')) continue;
        const section = node('section', 'form-builder-setting-card'); count++;
        if (field.type === 'table') {
          section.append(node('h3', '', field.label)); tableDefaults(section, field);
        } else {
          const control = defaultControl(field, field.default, v => {
            if (v === undefined) delete field.default; else field.default = v;
          });
          section.append(labelled(field.label, control, true));
        }
        panel.append(section);
      }
      if (!count) panel.append(ui('p', 'helper', 'Add a text, number, choice or table field to set a default value.'));
      body.append(panel);
    }

    function settingsPage() {
      const panel = node('div', 'form-builder-settings');
      const general = group('Template details'), access = group('Access'), print = group('Print layout');
      const description = input(model.description, v => { model.description = v; }, 'textarea');
      const displayId = input(model.settings.display_id, value => { model.settings.display_id = value; });
      displayId.maxLength = 80; description.maxLength = 4000;
      general.append(labelled('Template ID', displayId), labelled('Description', description));
      access.append(ui('p', 'helper', 'Choose the user types that can open this published template. Viewers can read forms. Editors and administrators can also fill them in.'));
      for (const [role, label] of Object.entries(roleNames))
        access.append(check(label, model.roles.includes(role), on => { model.roles = updateSet(model.roles, role, on); }));
      const workflow = group('Workflow');
      workflow.append(labelled('Template type', select(model.mode, [
        ['timeline', copy('Timeline')], ['workflow', copy('Approval workflow')],
      ], mode => {
        if (mode === 'timeline' && model.fields.some(f => f.type === 'approval')) {
          show('settings'); notify(copy('Remove approval signature fields before switching to timeline.'), true); return;
        }
        model.mode = mode;
        if (mode === 'workflow' && !model.settings.stages.length) model.settings.stages.push(makeStage());
        show('settings');
      })));
      if (model.mode === 'workflow') {
        const stages = model.settings.stages;
        stages.forEach((stage, i) => {
          const entry = node('div', 'form-builder-stage');
          entry.append(labelled('Stage name', input(stage.name, value => { stage.name = value; })));
          for (const role of ['editor','admin']) entry.append(check(roleNames[role], stage.roles.includes(role),
            on => { stage.roles = updateSet(stage.roles, role, on); }));
          const people = node('select'); people.multiple = true;
          const candidates = new Map(staff.filter(p => p.active !== false).map(p => [p.id, p.name || p.id]));
          for (const id of stage.member_ids || []) if (!candidates.has(id)) candidates.set(id, id);
          for (const [id,name] of candidates) {
            const opt = new Option(name,id); opt.selected = (stage.member_ids || []).includes(id); people.add(opt);
          }
          people.addEventListener('change', () => { stage.member_ids = [...people.selectedOptions].map(opt => opt.value); });
          entry.append(labelled('Restrict to staff members', people), ui('p','helper','Leave the selection empty to allow anyone with an authorised stage role.'));
          stageConditions(entry, stage, i);
          entry.append(arrangeTools(stages, i, () => show('settings'), () => {
            if (stages.length === 1) { notify(copy('Keep at least one workflow stage.'), true); return; }
            if (!window.confirm(copy('Remove this stage and assign its fields to the first stage?'))) return;
            stages.splice(i, 1);
            for (const field of model.fields) if (field.stage_id === stage.id) delete field.stage_id;
            show('settings');
          }));
          workflow.append(entry);
        });
        workflow.append(button('Add stage', () => {
          if (stages.length >= 50) { notify(copy('A workflow can have up to 50 stages.'), true); return; }
          stages.push(makeStage()); show('settings');
        }));
      }
      const register = group('Form register'), summaryFields = model.fields.filter(f => thumbnailTypes.has(f.type));
      register.append(labelled('Sort forms by', select(model.settings.sort_field, [
        ['', copy('Last updated')], ...summaryFields.map(f => [f.id, f.label]),
      ], value => { model.settings.sort_field = value; })));
      const fixedTables = model.fields.filter(f=>f.type==='table' && f.table_mode==='fixed' && f.default?.length &&
        f.columns.some(c=>registerCellTypes.has(c.type)));
      if (summaryFields.length || fixedTables.length) {
        register.append(ui('p', 'helper', 'Choose up to five fields or prefilled table cells for the register.'));
        for (const field of summaryFields) register.append(check(field.label, model.settings.summary_fields.includes(field.id), on => {
          if (on && registerCount() >= 5) {
            show('settings'); notify(copy('Choose up to five fields or prefilled table cells for the register.'), true); return;
          }
          model.settings.summary_fields = updateSet(model.settings.summary_fields, field.id, on);
        },true));
        if (fixedTables.length) registerCells(register,fixedTables);
      }
      print.append(labelled('Orientation', select(model.settings.orientation,
        [['portrait', copy('Portrait')], ['landscape', copy('Landscape')]], value => { model.settings.orientation = value; })),
        labelled('Header', input(model.settings.header, v => { model.settings.header = v; }, 'textarea')),
        labelled('Footer', input(model.settings.footer, v => { model.settings.footer = v; }, 'textarea')),
        check('Include a photo appendix', Boolean(model.settings.photo_appendix), on => { model.settings.photo_appendix = on; show('settings'); }));
      if (model.settings.photo_appendix) print.append(labelled('Photos per page',select(String(model.settings.photos_per_page || 1),
        [1,2,4,6,8,10].map(n=>[String(n),String(n)]),v=>{model.settings.photos_per_page=Number(v);})));
      if (window.ClassifireFormsLayout) {
        const area = node('div', 'form-builder-print-layout');
        print.append(area); window.ClassifireFormsLayout.edit(area, model.settings, remember);
      }
      const files = group('Template attachments'); attachmentSettings(files);
      panel.append(general, access, workflow, register, print, files); body.append(panel);
    }
    function makeStage() {
      return {id:fieldId(), name:copy('Stage') + ' ' + (model.settings.stages.length + 1), roles:['admin', 'editor']};
    }
    function registerCount() {
      return model.settings.summary_fields.length + model.settings.summary_cells.length;
    }
    function pruneRegisterCells() {
      model.settings.summary_cells = model.settings.summary_cells.filter(cell=>{
        const table = model.fields.find(f=>f.id===cell.field_id);
        return table?.type==='table' && table.table_mode==='fixed' && Number.isInteger(cell.row) &&
          cell.row>=0 && cell.row < (table.default?.length || 0) &&
          table.columns.some(c=>c.id===cell.column_id && registerCellTypes.has(c.type));
      });
    }
    function registerCells(host,tables) {
      const panel = group('Prefilled table cells');
      let table = tables[0], row = 0, column = '';
      const tableSelect = select(table.id,tables.map(t=>[t.id,t.label]),id=>{
        table = tables.find(t=>t.id===id); row = 0; column = ''; render();
      });
      const add = button('Add register cell',()=>{
        if (registerCount()>=5) { notify(copy('Choose up to five fields or prefilled table cells for the register.'),true); return; }
        if (model.settings.summary_cells.some(cell=>cell.field_id===table.id && cell.row===row && cell.column_id===column)) {
          notify(copy('This cell is already in the register.'),true); return;
        }
        model.settings.summary_cells.push({field_id:table.id,row,column_id:column}); render(); notify('');
      });
      function render() {
        const cols = table.columns.filter(c=>registerCellTypes.has(c.type));
        column ||= cols[0].id;
        panel.replaceChildren(ui('legend','','Prefilled table cells'),labelled('Table',tableSelect),
          labelled('Prefilled row',select(String(row),table.default.map((_,i)=>[String(i),String(i+1)]),v=>{row=Number(v);})),
          labelled('Register column',select(column,cols.map(c=>[c.id,c.label]),v=>{column=v;})),add);
        for (const [index,cell] of model.settings.summary_cells.entries()) {
          const selectedTable = tables.find(t=>t.id===cell.field_id);
          const selectedCol = selectedTable?.columns.find(c=>c.id===cell.column_id);
          if (!selectedCol) continue;
          const entry = node('div','form-builder-register-cell');
          const caption = [selectedTable.label,copy('Row')+' '+(cell.row+1),selectedCol.label].join(' · ');
          const remove = button('Remove',()=>{model.settings.summary_cells.splice(index,1);render();});
          remove.setAttribute('aria-label',copy('Remove')+' '+caption);
          entry.append(node('span','',caption),remove); panel.append(entry);
        }
      }
      render(); host.append(panel);
    }
    function stageConditionFields(stageIndex) {
      const stages = model.settings.stages;
      return model.fields.filter(f => {
        const index = f.stage_id ? stages.findIndex(s => s.id === f.stage_id) : 0;
        return index >= 0 && index <= stageIndex && (choiceTypes.has(f.type) || f.type === 'yes_no' || f.type === 'action');
      });
    }
    function conditionAnswers(field) {
      return field.type === 'action' ? actionStatuses : valuesFor(field);
    }
    function stageConditions(host, stage, index) {
      const rules = stage.approval_conditions || [], available = stageConditionFields(index).filter(f => conditionAnswers(f).length);
      const section = group('Approval conditions');
      section.append(ui('p','helper', available.length || rules.length
        ? 'Every condition must match before this stage can be approved.'
        : 'Add a list, Yes / No or action field in this or an earlier stage to require an answer before approval.'));
      rules.forEach((rule, i) => {
        const row = node('div','form-builder-stage-rule');
        const field = available.find(f => f.id === rule.field_id);
        row.append(labelled('Condition field',select(field?.id || '',[
          ['',copy('Choose a field')], ...available.map(f => [f.id,f.label]),
        ], id => {
          const selected = available.find(f => f.id === id);
          rule.field_id = id; rule.value = selected ? conditionAnswers(selected)[0] : '';
          show('settings');
        })));
        if (field) row.append(labelled(field.type === 'action' ? 'Action status' : 'Required answer',select(rule.value, [
          ['',copy('Choose an answer')],...conditionAnswers(field).map(v=>[v,v]),
        ],value => { rule.value = value; })));
        row.append(button('Remove condition', () => { rules.splice(i,1); show('settings'); }));
        section.append(row);
      });
      const add = button('Add condition', () => {
        const selected = available.find(f => !rules.some(r => r.field_id === f.id)) || available[0];
        (stage.approval_conditions ||= []).push({field_id:selected.id,value:conditionAnswers(selected)[0]});
        show('settings');
      });
      add.disabled = !available.length || rules.length >= 50;
      section.append(add); host.append(section);
    }
    function attachmentSettings(host) {
      const list = node('ul', 'form-builder-file-list');
      const upload = node('input'); upload.type = 'file'; upload.multiple = true;
      upload.addEventListener('change', async () => {
        const files = [...upload.files]; upload.value = '';
        if (!files.length || busy) return;
        const current = model.settings.attachments || [];
        const priorSize = current.reduce((total, file) => {
          const base64 = String(file.data).split(',')[1] || '';
          return total + base64.length * 3 / 4 - (base64.match(/=*$/)[0].length);
        }, 0);
        if (current.length + files.length > 16 || priorSize + files.reduce((total, file) => total + file.size, 0) > 1024 * 1024) {
          notify(copy('Attach up to 16 files, totalling at most 1 MiB.'), true); return;
        }
        busy = true; updateHeader();
        try {
          const entries = await Promise.all(files.map(file => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({name: file.name, type: file.type || 'application/octet-stream', data: String(reader.result)});
            reader.onerror = () => reject(Error(copy('The selected file could not be read.')));
            reader.readAsDataURL(file);
          })));
          model.settings.attachments = [...current, ...entries];
          draw(); notify('');
        } catch (e) { notify(e.message, true); }
        finally { busy = false; updateHeader(); remember(); }
      });
      function draw() {
        list.replaceChildren();
        (model.settings.attachments || []).forEach((file, i) => {
          const li = node('li'); li.append(node('span', '', file.name), button('Remove', () => {
            model.settings.attachments.splice(i, 1); draw();
          })); list.append(li);
        });
      }
      draw(); host.append(labelled('Attach reference files', upload), list);
    }
    updateHeader(); show('fields');
    return Object.freeze({snapshot:() => clone(model), isDirty:dirty, isBusy:() => busy});
  }
  window.ClassifireFormsBuilder = Object.freeze({mount});
})();
