"""Bound CPU-heavy evaluation across HTTP threads without changing snapshots."""

from collections import deque
from contextlib import contextmanager
from threading import Condition, RLock, get_ident


class CalculationBusy(Exception):
    pass


class CalculationGate:
    """One active evaluation, a bounded FIFO, and same-thread reentrancy.

    Main's lightweight calculation does not acquire this gate. Exports and
    interactive schedules share admission, so neither can starve the other.
    Every caller keeps its exact captured inputs; no result is substituted.
    """

    def __init__(self, max_pending=8):
        self.condition = Condition()
        self.pending = deque()
        self.owner = None
        self.depth = 0
        self.max_pending = max_pending

    def __enter__(self):
        identity = get_ident()
        with self.condition:
            if self.owner == identity:
                self.depth += 1
                return self
            if (self.owner is not None or self.pending) and len(self.pending) >= self.max_pending:
                raise CalculationBusy('Calculation capacity is busy. Please retry when the current calculations finish.')
            ticket = object()
            self.pending.append(ticket)
            try:
                self.condition.wait_for(lambda: self.owner is None and self.pending[0] is ticket)
                self.pending.popleft()
                self.owner, self.depth = identity, 1
            except BaseException:
                self.pending.remove(ticket)
                self.condition.notify_all()
                raise
        return self

    def __exit__(self, *exception):
        with self.condition:
            self.depth -= 1
            if not self.depth:
                self.owner = None
                self.condition.notify_all()


evaluation_gate = CalculationGate()


class EvaluationLock:
    """Preserve the evaluator RLock, always acquiring global admission first."""

    def __init__(self):
        self.lock = RLock()

    def __enter__(self):
        evaluation_gate.__enter__()
        try:
            self.lock.acquire()
        except BaseException:
            evaluation_gate.__exit__()
            raise
        return self

    def __exit__(self, *exception):
        self.lock.release()
        evaluation_gate.__exit__(*exception)


@contextmanager
def calculation_work():
    with evaluation_gate:
        yield
