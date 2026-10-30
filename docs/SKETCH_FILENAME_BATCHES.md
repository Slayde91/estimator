# Construction sketch attachment batches

Run from PowerShell:

```powershell
& C:\ESTIMATOR\app\scripts\next_sketch_filenames.ps1
```

Or double-click `C:\ESTIMATOR\app\scripts\next_sketch_filenames.cmd`.

The first run includes `fas190234-p57-t0-c17`. Every subsequent run
returns the next ten existing image filenames in numeric page/component order,
prints one line such as `"image1" "image2"`, and copies it to the clipboard.
All output omits file extensions, including when using `-FullPaths`; source files
and the saved queue retain their actual names with extensions for validation.
In the attachment picker, open `C:\ESTIMATOR\app\.runtime\reference-library\images`,
paste into **File name**, and confirm. A final batch may contain fewer than ten;
after the last batch, the script produces no output and leaves the clipboard alone.

For a picker that is in another folder, use `-FullPaths`. For a failed attachment,
use `-Repeat` to copy the last batch without advancing again. Use `-Preview` to
inspect the next batch without changing progress or the clipboard. Use
`-NoClipboard` to print/save the batch in a headless terminal.

```powershell
& C:\ESTIMATOR\app\scripts\next_sketch_filenames.ps1 -Repeat
& C:\ESTIMATOR\app\scripts\next_sketch_filenames.ps1 -Preview
& C:\ESTIMATOR\app\scripts\next_sketch_filenames.ps1 -StartFrom fas190234-p57-t0-c17
```

`-StartFrom` explicitly restarts the queue, including that file, and accepts a
filename, filename without extension, or full path. `-Source` and `-StateDirectory`
allow independent queues. The default queue and `last-batch.txt` live in
`C:\ESTIMATOR\output\sketch-filename-batches`. Keep this state between launches.
The queue freezes filename order when created, so moving processed originals out
of the source folder does not cause later batches to be skipped. If an upcoming
file is missing, the script stops without advancing. New images are included only
when explicitly restarting the queue. Concurrent launches share an exclusive lock.

This helper prepares attachment filenames; it does not attach files, send chat
messages, generate images, move originals, or verify generated technical details.
Continue generation in **Create construction sketch variations** using that chat's
existing model, instructions, review, and installation workflow. The saved cursor
records filenames handed out, not completed generations.
