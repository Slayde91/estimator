# Bounded calculation work

Steel board and spray reuse only pure scalar criteria comparisons. The shared
LRU holds at most 8,192 results. Keys retain exact types and values; strings
over 128 characters, integers over 64 bits, non-finite floats and other objects
use the original matcher. Results contain no cells, prices, sources or mutable
objects. Duct and Firestopping retain the original comparison path. Existing
model/assessment-specific evaluator sessions and their six-entry LRU remain.

Firestopping builds the inventory overlays and definition once per calculation.
Normalized choice sets and each normalized row's labour result are reused in
that request. Nothing is cached across frozen pricing configurations. The API
adds the current service vocabulary during that same definition construction.
PDF/XLSX writers use the definition captured with their result.

Main, workbook navigation, Firestopping composer and Firestopping schedule each
allow one active automatic calculation and one newest pending calculation.
Replacing pending work settles its caller without a result. Revision, project,
pricing and validation guards apply before dispatch and before accepting a
reply. Bodies capture the original exact inputs. The library editor already
serializes calculation and reschedules edits made while busy.

Heavy workbook evaluation, report projection, Firestopping calculation and
library pricing share a process-wide gate: one active operation, at most eight
waiting operations, FIFO admission, and reentrancy for nested same-thread work.
The evaluator's existing RLock remains inside this admission boundary. An
excess request receives HTTP 503 with Retry-After and an explicit retry message;
no partial result is published. Ordinary Main calculations without schedules
remain outside the heavy gate. Save/export callers retain their exact snapshot
and are never replaced by the automatic client queue.

Library creation, saves and pricing refreshes acquire admission after their
existing library lock and retain it through persistence and the final response.
An overloaded request therefore cannot write a pricing snapshot or save an item
and then fail while acquiring admission for its response. Delete does not need
calculation admission. Database transactions never wait for this admission.

Running work is allowed to finish. Aborting fetch does not establish server
cancellation, so automatic edits no longer use that as a CPU scheduling policy.
Cooperative cancellation would require separate validation of interrupted
mutable evaluator state. A latest answer can still wait for active work, and a
heavy Python calculation can still affect Main's response time. This is not a
worker-process or incremental-dependency redesign.

Validation includes complete unrounded response hashes for 1, 60 and 1,000-row
synthetic schedules, native Excel fixtures, type/coercion/wildcard/error cases,
cache bounds, queue saturation/reentrancy/failure recovery, stale project and
pricing guards, real-browser rapid editing, and exact-snapshot exports. Timing
observations are local diagnostics, not production latency guarantees.
