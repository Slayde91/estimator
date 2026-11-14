"""A bounded arithmetic language for form tables. Cell references are relative to row one."""
import re
from datetime import date, datetime, time
from decimal import Decimal, DecimalException, localcontext

from .catalog import ValidationError


REFERENCE = re.compile(r'(?:(?:Table([1-9]\d{0,2}))!)?\$?([A-Z]{1,3})(\$?)([1-9]\d{0,4})', re.I)
TOKEN = re.compile(r'\s*(?:(?P<ref>' + REFERENCE.pattern + r')|(?P<number>\d+(?:\.\d+)?|\.\d+)'
                   r'|(?P<string>"(?:[^"]|"")*")|(?P<fn>SUM|AVERAGE|MIN|MAX|IF|DATEDIF|TIMEDIF)'
                   r'|(?P<symbol><=|>=|<>|[=<>()+*/:,-]))', re.I)
COMPARISONS = ('=','<>','<','<=','>','>=')
OPERATORS = {**dict.fromkeys(COMPARISONS,0), '+':1, '-':1, '*':2, '/':2}
DERIVED = {'formula','list_property'}


def parse_formula(expression):
    if not isinstance(expression,str) or not expression.startswith('=') or len(expression)>512:
        raise ValidationError('Begin the table formula with = and use up to 512 characters.')
    expression = expression[1:].strip()
    tokens = []
    start = 0
    while start<len(expression):
        match = TOKEN.match(expression,start)
        if not match or len(tokens)>=128:
            raise ValidationError('Use numeric values, A1 references, arithmetic or supported aggregate functions.')
        value = match.group(0).strip()
        tokens.append(value if match.group('string') else value.upper())
        start = match.end()
    tokens.append('')
    position = 0

    def consume(token):
        nonlocal position
        if tokens[position]!=token:
            raise ValidationError('Check the table formula syntax.')
        position += 1

    def parse(minimum=0,depth=0):
        nonlocal position
        token = tokens[position]
        if not token or depth>24:
            raise ValidationError('The table formula is incomplete or too complex.')
        position += 1
        if token in ('+','-'):
            node = ('unary',token,parse(3,depth+1))
        elif token=='(':
            node = parse(0,depth+1)
            consume(')')
        elif token in ('SUM','AVERAGE','MIN','MAX','IF','DATEDIF','TIMEDIF'):
            consume('(')
            args = [parse(0,depth+1)]
            while tokens[position]==',':
                position += 1
                args.append(parse(0,depth+1))
            consume(')')
            if token=='IF' and len(args)!=3 or token in ('DATEDIF','TIMEDIF') and len(args) not in (2,3):
                raise ValidationError(f'Check the number of arguments to {token}.')
            node = ('function',token,args)
        elif REFERENCE.fullmatch(token):
            node = ('cell',token)
            if tokens[position]==':':
                position += 1
                end = tokens[position]
                if not REFERENCE.fullmatch(end):
                    raise ValidationError('A range must end with a cell reference.')
                position += 1
                node = ('range',token,end)
        elif token[0]=='"':
            node = ('string',token[1:-1].replace('""','"'))
        elif token[0].isdigit() or token[0]=='.':
            if len(token)>40:
                raise ValidationError('The number in the table formula is too large.')
            node = ('number',Decimal(token))
        else:
            raise ValidationError('Check the table formula syntax.')
        while tokens[position] in OPERATORS and OPERATORS[tokens[position]]>=minimum:
            op = tokens[position]
            position += 1
            node = ('binary',op,node,parse(OPERATORS[op]+1,depth+1))
        return node

    result = parse()
    if tokens[position]:
        raise ValidationError('Check the table formula syntax.')
    return result


class CellError(ValueError):
    """A spreadsheet error that can be displayed on an incomplete draft."""


def elapsed(function,start,end,unit=None):
    try:
        if function=='DATEDIF':
            first,last = (date.fromisoformat(str(v)[:10]) for v in (start,end))
            if last<first:
                raise CellError('#NUM!')
            months = (last.year-first.year)*12 + last.month-first.month - int(last.day<first.day)
            if unit in (None,'D'):
                return Decimal((last-first).days)
            if unit in ('M','Y'):
                return Decimal(months if unit=='M' else months//12)
        else:
            def moment(v):
                if 'T' in v:
                    return datetime.fromisoformat(v)
                return datetime.combine(date(2000,1,1),time.fromisoformat(v))
            delta = moment(end)-moment(start)
            seconds = Decimal(delta.days*86400+delta.seconds)+Decimal(delta.microseconds)/1000000
            divisors = {'H':3600,'M':60,'S':1}
            if unit is None or unit in divisors:
                return seconds/divisors[unit or 'H']
    except CellError:
        raise
    except (ValueError,TypeError,OverflowError):
        pass
    raise CellError('#VALUE!')


def number(value):
    if value is None or value=='':
        return Decimal(0)
    if type(value) not in (int,float,str) or len(str(value))>100:
        raise CellError('#VALUE!')
    try:
        numeric = Decimal(str(value))
        if not numeric.is_finite() or numeric and abs(numeric.adjusted())>100:
            raise CellError('#NUM!')
        return numeric
    except DecimalException:
        raise CellError('#VALUE!') from None


def derive_tables(fields, values, *, complete=False, frozen=()):
    """Return only derived cells. Frozen signed stages supply their archived values."""
    tables = [field for field in fields if field['type']=='table']
    rows = [values.get(field['id'],[]) for field in tables]
    if (any(not isinstance(items,list) or len(items)>500 or any(not isinstance(row,dict) for row in items)
            for items in rows) or sum(len(table['columns'])*len(items) for table,items in zip(tables,rows))>25000):
        raise ValidationError('Form tables support up to 500 rows per table and 25,000 cells per form.')
    formulas = {}
    for t,table in enumerate(tables):
        for c,column in enumerate(table['columns']):
            if column['type']=='formula' and column.get('formula'):
                formulas[t,c] = parse_formula(column['formula'])
    results, cache, visiting = {}, {}, set()
    budget = 100000

    def step(depth):
        nonlocal budget
        budget -= 1
        if budget<0:
            raise ValidationError('The form table calculation exceeds its operation limit.')
        if depth>96:
            raise CellError('#DEPTH!')

    def coordinate(ref, t, row):
        table_no, letters, absolute_row, index = REFERENCE.fullmatch(ref).groups()
        col = 0
        for char in letters:
            col = col*26 + ord(char.upper())-64
        table_no = int(table_no)-1 if table_no else t
        index = int(index)-1 + (0 if absolute_row else row)
        if not 0<=table_no<len(tables) or not 0<=col-1<len(tables[table_no]['columns']) or index>=500:
            raise CellError('#REF!')
        return table_no,index,col-1

    def cell(t,row,c,depth):
        step(depth)
        if row>=len(rows[t]):
            return None
        address = (t,row,c)
        if address in cache:
            return cache[address]
        if address in visiting:
            raise CellError('#CYCLE!')
        column = tables[t]['columns'][c]
        data = rows[t][row]
        if column['type'] not in DERIVED or tables[t]['id'] in frozen:
            return data.get(column['id'])
        visiting.add(address)
        try:
            if column['type']=='list_property':
                selected = data.get(column.get('source_column'))
                value = column.get('mapping',{}).get(selected,'') if isinstance(selected,str) else ''
            else:
                value = evaluate(formulas[t,c],t,row,depth+1) if (t,c) in formulas else None
                if isinstance(value,list):
                    raise CellError('#VALUE!')
                if isinstance(value,Decimal) or type(value) in (float,int):
                    value = format(number(str(value)),'f')
                    if '.' in value:
                        value = value.rstrip('0').rstrip('.')
                elif value is not None and (not isinstance(value,str) or len(value)>500):
                    raise CellError('#VALUE!')
            cache[address] = value
            return value
        finally:
            visiting.remove(address)

    def evaluate(node,t,row,depth):
        step(depth)
        kind = node[0]
        if kind in ('number','string'):
            return node[1]
        if kind=='cell':
            return cell(*coordinate(node[1],t,row),depth+1)
        if kind=='range':
            start,r1,c1 = coordinate(node[1],t,row)
            end,r2,c2 = coordinate(node[2],start,row)
            if start!=end:
                raise CellError('#REF!')
            return [cell(start,r,c,depth+1) for r in range(min(r1,r2),max(r1,r2)+1)
                    for c in range(min(c1,c2),max(c1,c2)+1)]
        if kind=='unary':
            result = scalar(evaluate(node[2],t,row,depth+1))
            return result if node[1]=='+' else -result
        if kind=='binary':
            left = evaluate(node[2],t,row,depth+1)
            right = evaluate(node[3],t,row,depth+1)
            if node[1] in COMPARISONS:
                if isinstance(left,(list,dict)) or isinstance(right,(list,dict)):
                    raise CellError('#VALUE!')
                try:
                    left,right = scalar(left),scalar(right)
                except CellError:
                    left,right = str(left or '').casefold(),str(right or '').casefold()
                comparison = (left>right)-(left<right)
                checks = {'=':comparison==0,'<>':comparison!=0,'<':comparison<0,'<=':comparison<=0,
                          '>':comparison>0,'>=':comparison>=0}
                return Decimal(int(checks[node[1]]))
            left,right = scalar(left),scalar(right)
            if node[1]=='+':
                return left+right
            if node[1]=='-':
                return left-right
            if node[1]=='*':
                return left*right
            if not right:
                raise CellError('#DIV/0!')
            return left/right
        if node[1]=='IF':
            condition = scalar(evaluate(node[2][0],t,row,depth+1))
            return evaluate(node[2][1 if condition else 2],t,row,depth+1)
        if node[1] in ('DATEDIF','TIMEDIF'):
            arguments = [evaluate(arg,t,row,depth+1) for arg in node[2]]
            return elapsed(node[1],*arguments)
        numbers = []
        for argument in node[2]:
            value = evaluate(argument,t,row,depth+1)
            for item in value if isinstance(value,list) else [value]:
                if item not in (None,''):
                    try:
                        numbers.append(scalar(item))
                    except CellError:
                        if not isinstance(value,list):
                            raise
        if node[1]=='SUM':
            return sum(numbers,Decimal(0))
        if node[1]=='AVERAGE':
            if not numbers:
                raise CellError('#DIV/0!')
            return sum(numbers)/len(numbers)
        return (min if node[1]=='MIN' else max)(numbers,default=Decimal(0))

    def scalar(value):
        return value if isinstance(value,Decimal) else number(value)

    with localcontext() as context:
        context.prec = 28
        context.Emax, context.Emin = 100, -100
        for t,table in enumerate(tables):
            derived = [(c,column) for c,column in enumerate(table['columns']) if column['type'] in DERIVED]
            if not derived or table['id'] in frozen:
                continue
            output = []
            for r in range(len(rows[t])):
                item = {}
                for c,column in derived:
                    try:
                        result = cell(t,r,c,0)
                    except (CellError,DecimalException) as error:
                        result = str(error) if isinstance(error,CellError) else '#NUM!'
                        if complete:
                            raise ValidationError(f'Check {table["label"]}, row {r+1}, {column["label"]}: {result}') from None
                    item[column['id']] = result
                output.append(item)
            results[table['id']] = output
    return results
