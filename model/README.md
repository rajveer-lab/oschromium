# The eviction model

How Smart Tab Saver decides which tab to put to sleep, how the model was trained, and how it compares with LRU and with the model it replaced. Everything here can be re-run:

```bash
node model/train.mjs           # results table for the model in policy.js
node model/train.mjs --train   # retrain from scratch (about 3 minutes), then the table
node model/bench.mjs           # the earlier experiments (feature sets, losses)
```

## What changed, and why

The first model scored each tab on its own from 8 features of its history, trained to say whether the tab would be needed within 2C switches. On the bench below it was worse than plain LRU by itself (about 6 times the reloads on task browsing). Only the LRU fallback and the regret guard kept it near LRU, and still 8% worse. Three changes fixed that.

1. **Features about the other tabs and about tasks (8 → 13).** LRU's strength is comparing tabs; the model couldn't. It now also gets each tab's recency rank and use-count rank among the tabs that could sleep, how many of its last four uses were recent, whether it belongs to the task you're on, and how long since its task was used (tasks come from the extension's own clustering).
2. **Listwise training with DAgger.** Instead of a yes/no label per tab, the model learns, at each moment a tab must sleep, to pick the tab Belady's OPT would pick (a softmax over the candidates). Trained only on OPT's own path, it picked an OPT-optimal tab 62% of the time yet caused 7 times more reloads, because its mistakes led to situations it had never seen. DAgger (Ross et al. 2011, used for caching by Parrot, Liu et al. 2020) fixes this: run the model, ask OPT what it should have done where the model actually went, add those examples and refit. The score is then calibrated (Platt scaling) so the popup's "% likely not needed soon" and the confidence threshold still mean what they say.
3. **Switching instead of a random guard.** The model and LRU both run as shadows on the same switches, and whichever caused fewer reloads lately (a count that halves every 100 switches) decides. This is the simple robust method from Chłędowski et al. 2021 ("follow the better of the predictor and a classical algorithm"), in the spirit of Wei 2020 (combining a predictor with LRU). It keeps the model within about 1% of LRU when it's wrong for you, and lets it decide when it's right.

## Results

Reloads per 1,200 tab switches, mean over held-out strings (generated with different seeds from the training strings). A quarter of tabs get no task, to match the clustering's recall in the report.

| Workload | C | OPT | LRU | Old: model + regret guard | New model alone | **New: model + switching** |
|---|---|---|---|---|---|---|
| Task browsing | 4 | 146.0 | 240.4 | 255.1 | 260.7 | **241.8** |
| Task browsing | 8 | 42.1 | 112.3 | 121.5 | 106.9 | **107.0** |
| Task browsing | 12 | 13.0 | 66.6 | 71.9 | 62.6 | **64.0** |
| Browsing + comparison sweeps | 4 | 206.0 | 319.0 | 330.2 | 328.3 | **320.8** |
| Browsing + comparison sweeps | 8 | 104.3 | 231.7 | 242.0 | 176.8 | **177.2** |
| Browsing + comparison sweeps | 12 | 50.9 | 105.8 | 135.6 | 74.0 | **74.3** |
| Cyclic loop, 10 tabs | 8 | 264.0 | 1190.0 | 1190.0 | 1181.0 | **1181.0** |
| Uniform random, 12 tabs | 8 | 186.0 | 430.0 | 431.0 | 416.0 | **428.0** |

Against LRU, the shipped policy now has 5% fewer reloads on task browsing at C = 8 and 4% at C = 12, 24% and 30% fewer when browsing includes comparison sweeps, and is at most about 1% worse anywhere (at C = 4). The old policy was up to 28% worse than LRU.

**Limits.** The strings are synthetic, generated from the model of browsing in the Review 3 report (section 13.1), not real users' histories. With perfect task labels the gains are larger (about 13% fewer reloads than LRU on task browsing at C = 8), so better task clustering would help directly. At C = 4 there is little room and the model alone is worse than LRU; switching hands those decisions to LRU. "Learn from my browsing" uses the same training on your own switches (about 0.6 s for 600 switches), but with that little history it rarely beats the pretrained model: in a test on 10 strings the acceptance check kept the retrained model 2 times out of 10.

## Files

| File | What it does |
|---|---|
| `../policy.js` | Features, the model, `trainModel` (DAgger + listwise + calibration) and `replay`: used by the extension and by these scripts |
| `workloads.mjs` | Seeded generators: task browsing, browsing with comparison sweeps, cyclic loop, uniform random |
| `train.mjs` | Trains the pretrained model and prints the table above |
| `bench.mjs` | The experiments: old vs new features, binary vs listwise vs reuse-distance regression, with and without DAgger |

## References

- T. Lykouris and S. Vassilvitskii, "Competitive caching with machine learned advice," ICML 2018 (arXiv:1802.05399).
- A. Wei, "Better and simpler learning-augmented online caching," APPROX 2020 (arXiv:2005.13716).
- J. Chłędowski, A. Polak, B. Szabucki and K. Zolna, "Robust learning-augmented caching: an experimental study," ICML 2021 (arXiv:2106.14693).
- S. Ross, G. Gordon and D. Bagnell, "A reduction of imitation learning and structured prediction to no-regret online learning," AISTATS 2011.
- E. Z. Liu, M. Hashemi, K. Swersky, P. Ranganathan and J. Ahn, "An imitation learning approach for cache replacement," ICML 2020.
