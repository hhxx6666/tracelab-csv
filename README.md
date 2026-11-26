# TraceLab · experiment data comparator

Drop in two CSVs, align both runs on the same trigger event, find the intervals that leave tolerance, and export a self-contained HTML report. Parsing and arithmetic happen in the browser — no upload, no build step.

[简体中文](README.zh-CN.md) · **[Live demo](https://hhxx6666.github.io/tracelab-csv/)** · MIT

## 30-second demo

1. Click **Load motor sample**. The baseline run crosses the start command threshold at **1.2125 s** and the candidate run at **1.860 s**. The chart shifts both starts to **t = 0**.
2. Keep the absolute tolerance at **±50 rpm**. The candidate overshoots briefly after the start, and roughly **0.583–1.366 s** turns red. The interval lasts **0.782 s** with a peak deviation of about **+167.0 rpm**.
3. Click **Export HTML report** to download a report containing both charts, the out-of-tolerance intervals and the input parameters. Copy the file to another machine and it still opens.
4. To walk the real import flow, drag [baseline sample CSV](samples/motor-baseline.csv) and [candidate sample CSV](samples/motor-v2.csv) onto A and B, enter **50** as the tolerance, then swap in your own recordings.

Both samples are deterministically generated fixtures. The baseline is sampled every 25 ms, the candidate every 20 ms.

## CSV format and trigger settings

Use UTF-8 CSV with a unique column name on the first row. Commas, semicolons and tabs are supported, as are quoted fields.

```csv
time_s,start_cmd,speed_rpm
0.000,0,0
0.025,0,0
0.050,1,105
0.075,1,284
```

- The two files may use different column names and may each be in seconds or milliseconds. The time column must increase strictly and the selected columns must hold finite numbers. Both signals should share the same unit. Each file is limited to 10 MiB.
- Pick the time, trigger and signal columns for each file under **Column mapping and trigger**. A rising edge goes from below the threshold to the threshold or above; a falling edge is the reverse. The trigger time is resolved by linear interpolation. You can choose the n-th crossing, or align on the **first sample** instead.
- Only the overlapping period is compared. The deviation is interpolated on the union of both time axes, and the moments where it crosses the tolerance boundary are solved for. A deviation counts as out of tolerance only when its absolute value is strictly greater than the tolerance; boundaries are reported to the millisecond. Signed deviation is **candidate B − baseline A**.

## Run locally and deploy

Download the repository and open `index.html` in a modern browser. The app is plain HTML, CSS and JavaScript with Canvas charts — no dependencies to install and no build to run.

To publish your own copy, open **Settings → Pages** in your repository and deploy **main / (root)** with **Deploy from a branch**. See the [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Tests

`assets/compare.js` also exports itself as CommonJS, so the comparison core runs under Node.js 22 or newer with nothing to install:

```sh
node --test
```

The suite covers CSV parsing, column guessing, trigger alignment, the tolerance boundary, and how out-of-tolerance intervals split and merge. One test pins the demo numbers quoted above so the docs cannot drift.

## License

[MIT](LICENSE)
