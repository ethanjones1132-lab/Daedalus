### gpt-oss-20b expert pruning (tier2b)

| Variant | Calibration | Score | A | B | C | D | E | Median tokens | Minutes |
|---|---|---|---|---|---|---|---|---|---|
| full (32 experts) | - | 109/117 | 34/36 | 16/21 | 21/21 | 20/21 | 18/18 | 242 | 22.6 |
| keep24 | own transcripts | 107/117 | 36/36 | 12/21 | 21/21 | 21/21 | 17/18 | 256 | 13.1 |
| keep16 | own transcripts | 77/117 | 33/36 | 1/21 | 20/21 | 21/21 | 2/18 | 307 | 17.1 |
| keep16 | stdlib source (stopped) | 9/39 | 3/15 | 0/6 | 4/9 | 2/6 | 0/3 | 4096 | None |

### Speed-lab winners

| Model | Winner | CPU layers | Spec | Extra | Mean tok/s | Base tok/s | Fewer experts (lossy) |
|---|---|---|---|---|---|---|---|
| gptoss20b | ngram-only-11 | 11 | ngram-mod d16 | - | 46.26 | 21.3 | top-3: 26.52 |
| gemma26b | plus-ngram | 16 | draft-mtp,ngram-mod d2 | - | 101.7 | 46.26 | top-6: 55.83 |
| qwen36keep96 | combined:draft-mtp,ngram-mod:0:2: | 0 | draft-mtp,ngram-mod d2 | - | 274.46 | 130.32 | top-6: 132.48 |
| gptoss20b-keep24 | combined:ngram-mod:7:16: | 7 | ngram-mod d16 | - | 86.87 | 26.03 | top-3: 33.89 |

### Speed lab: gptoss20b

| Config | CPU layers | Spec | Mean tok/s | Gen | 2k edit | 10k ctx | Prefill 10k | Accept | VRAM MiB | RAM flag |
|---|---|---|---|---|---|---|---|---|---|---|
| place-14 | 14 | draft-eagle3 d3 | 21.3 | 25.86 | 27.81 | 10.23 | 499.3 | 0.356 | 6998 | yes |
| place-15 | 15 | draft-eagle3 d3 | 19.98 | 24.32 | 25.49 | 10.12 | 520.8 | 0.349 | 6557 | yes |
| place-16 | 16 | draft-eagle3 d3 | 18.94 | 22.33 | 24.46 | 10.04 | 493.3 | 0.356 | 6170 | yes |
| threads6 | 14 | draft-eagle3 d3 | 18.68 | 22.51 | 23.23 | 10.29 | 551.4 | 0.356 | 6983 |  |
| threads6-prio2 | 14 | draft-eagle3 d3 | 20.45 | 25.16 | 25.91 | 10.27 | 567.5 | 0.356 | 6983 |  |
| threads10 | 14 | draft-eagle3 d3 | 22.22 | 27.23 | 27.99 | 11.45 | 577.1 | 0.356 | 6983 | yes |
| no-mmap (server exited 1 during load) | 14 | draft-eagle3 d3 | None | None | None | None | None | None | None |  |
| kv-f16 | 14 | draft-eagle3 d3 | 22.27 | 28.01 | 27.22 | 11.57 | 571.2 | 0.361 | 7046 |  |
| depth2 | 14 | draft-eagle3 d2 | 24.57 | 29.08 | 30.3 | 14.34 | 565.1 | 0.446 | 6983 | yes |
| depth4 | 14 | draft-eagle3 d4 | 20.07 | 25.35 | 25.37 | 9.48 | 570.0 | 0.291 | 6983 | yes |
| depth5 | 14 | draft-eagle3 d5 | 18.23 | 23.14 | 22.97 | 8.57 | 564.0 | 0.246 | 6983 |  |
| plus-ngram | 14 | draft-eagle3,ngram-mod d3 | 42.9 | 45.48 | 61.34 | 21.87 | 572.9 | 0.555 | 6997 | yes |
| nospec-11 | 11 | none | 34.01 | 34.18 | 33.89 | 33.95 | 709.6 | None | 7052 |  |
| ngram-only-11 | 11 | ngram-mod d16 | 46.26 | 36.34 | 70.87 | 31.58 | 689.2 | 0.534 | 7071 |  |
| nospec-12 | 12 | none | 32.2 | 32.94 | 31.61 | 32.05 | 702.1 | None | 6649 | yes |
| ngram-only-12 | 12 | ngram-mod d16 | 48.47 | 37.11 | 74.56 | 33.75 | 714.5 | 0.641 | 6666 | yes |
| nospec-13 | 13 | none | 31.14 | 31.75 | 30.7 | 30.98 | 662.1 | None | 6252 | yes |
| ngram-only-13 | 13 | ngram-mod d16 | 49.31 | 32.34 | 85.38 | 30.21 | 637.6 | 0.645 | 6263 | yes |
| experts3 | 14 | draft-eagle3 d3 | 26.52 | 30.28 | 34.76 | 14.52 | 588.0 | 0.324 | 6972 | yes |
| ub1024 | 14 | draft-eagle3 d3 | 21.52 | 25.93 | 27.27 | 11.37 | 683.2 | 0.361 | 7189 | yes |
| combined | 11 | ngram-mod d16 | 63.56 | 33.75 | 68.21 | 88.71 | 703.4 | 0.739 | 7243 |  |

### Speed lab: gemma26b

| Config | CPU layers | Spec | Mean tok/s | Gen | 2k edit | 10k ctx | Prefill 10k | Accept | VRAM MiB | RAM flag |
|---|---|---|---|---|---|---|---|---|---|---|
| place-14 | 14 | draft-mtp d2 | 43.29 | 47.21 | 46.18 | 36.49 | 787.8 | 0.853 | 7278 | yes |
| place-16 | 16 | draft-mtp d2 | 46.26 | 44.64 | 48.02 | 46.12 | 728.1 | 0.868 | 6843 | yes |
| place-18 | 18 | draft-mtp d2 | 42.74 | 40.75 | 44.62 | 42.86 | 676.6 | 0.863 | 6259 | yes |
| place-20 | 20 | draft-mtp d2 | 39.13 | 36.59 | 40.81 | 40.0 | 625.9 | 0.858 | 5677 | yes |
| threads6 | 16 | draft-mtp d2 | 42.74 | 40.47 | 45.99 | 41.75 | 754.3 | 0.868 | 6836 |  |
| threads6-prio2 | 16 | draft-mtp d2 | 42.97 | 41.51 | 44.81 | 42.58 | 735.6 | 0.868 | 6846 |  |
| threads10 | 16 | draft-mtp d2 | 47.99 | 46.76 | 49.48 | 47.72 | 739.8 | 0.868 | 6843 | yes |
| no-mmap (server exited 1 during load) | 16 | draft-mtp d2 | None | None | None | None | None | None | None |  |
| kv-f16 | 16 | draft-mtp d2 | 48.83 | 47.53 | 49.74 | 49.21 | 743.1 | 0.852 | 7085 |  |
| depth1 | 16 | draft-mtp d1 | 43.74 | 42.6 | 44.74 | 43.88 | 734.3 | 0.909 | 6843 |  |
| depth3 | 16 | draft-mtp d3 | 48.29 | 45.56 | 51.76 | 47.55 | 743.8 | 0.835 | 6843 | yes |
| depth4 | 16 | draft-mtp d4 | 47.01 | 42.97 | 51.75 | 46.3 | 739.7 | 0.763 | 6843 | yes |
| plus-ngram | 16 | draft-mtp,ngram-mod d2 | 101.7 | 70.81 | 128.14 | 106.14 | 743.3 | 0.832 | 6861 | yes |
| experts6 | 16 | draft-mtp d2 | 55.83 | 54.79 | 59.96 | 52.73 | 793.9 | 0.822 | 6841 | yes |
| ub1024 | 16 | draft-mtp d2 | 46.05 | 45.17 | 47.37 | 45.61 | 1149.6 | 0.854 | 7024 | yes |
| combined:draft-mtp,ngram-mod:16:2:-t 10  | 16 | draft-mtp,ngram-mod d2 | 75.75 | 78.29 | 85.5 | 63.46 | 721.1 | 0.727 | 7101 | yes |

### Speed lab: qwen36keep96

| Config | CPU layers | Spec | Mean tok/s | Gen | 2k edit | 10k ctx | Prefill 10k | Accept | VRAM MiB | RAM flag |
|---|---|---|---|---|---|---|---|---|---|---|
| place-0 | 0 | draft-mtp d2 | 130.32 | 120.97 | 138.6 | 131.4 | 2068.0 | 0.858 | 5697 |  |
| kv-f16 | 0 | draft-mtp d2 | 128.57 | 112.01 | 139.92 | 133.79 | 2077.2 | 0.798 | 5847 |  |
| depth1 | 0 | draft-mtp d1 | 103.92 | 105.47 | 109.22 | 97.07 | 2068.4 | 0.879 | 5633 |  |
| depth3 | 0 | draft-mtp d3 | 135.73 | 116.23 | 148.07 | 142.88 | 2054.8 | 0.784 | 5759 |  |
| depth4 | 0 | draft-mtp d4 | 129.87 | 96.79 | 148.99 | 143.84 | 2057.7 | 0.652 | 5823 |  |
| plus-ngram | 0 | draft-mtp,ngram-mod d2 | 264.97 | 158.13 | 342.25 | 294.53 | 2053.1 | 0.821 | 5736 | yes |
| nospec-0 | 0 | none | 74.36 | 77.42 | 74.73 | 70.92 | 2171.6 | None | 5277 | yes |
| ngram-only-0 | 0 | ngram-mod d16 | 206.52 | 83.4 | 242.87 | 293.28 | 2174.0 | 0.781 | 5285 | yes |
| experts6 | 0 | draft-mtp d2 | 132.48 | 119.33 | 142.14 | 135.97 | 2116.0 | 0.821 | 5655 |  |
| ub1024 | 0 | draft-mtp d2 | 128.36 | 120.76 | 137.33 | 127.0 | 2344.0 | 0.842 | 5906 |  |
| combined:draft-mtp,ngram-mod:0:2: | 0 | draft-mtp,ngram-mod d2 | 274.46 | 159.06 | 361.55 | 302.78 | 2066.0 | 0.821 | 5706 |  |

### Speed lab: gptoss20b-keep24

| Config | CPU layers | Spec | Mean tok/s | Gen | 2k edit | 10k ctx | Prefill 10k | Accept | VRAM MiB | RAM flag |
|---|---|---|---|---|---|---|---|---|---|---|
| place-11 | 11 | draft-eagle3 d3 | 26.03 | 29.73 | 34.45 | 13.92 | 836.3 | 0.329 | 6826 | yes |
| place-12 | 12 | draft-eagle3 d3 | 23.26 | 25.57 | 31.07 | 13.14 | 760.7 | 0.319 | 6555 |  |
| threads6 | 11 | draft-eagle3 d3 | 22.7 | 26.42 | 29.83 | 11.85 | 788.9 | 0.329 | 6833 |  |
| threads6-prio2 | 11 | draft-eagle3 d3 | 23.68 | 27.09 | 31.49 | 12.47 | 799.2 | 0.329 | 6833 |  |
| threads10 | 11 | draft-eagle3 d3 | 26.28 | 31.08 | 33.54 | 14.23 | 811.8 | 0.329 | 6835 |  |
| no-mmap (server exited 1 during load) | 11 | draft-eagle3 d3 | None | None | None | None | None | None | None |  |
| kv-f16 | 11 | draft-eagle3 d3 | 26.45 | 30.19 | 34.42 | 14.74 | 807.0 | 0.332 | 7017 |  |
| depth2 | 11 | draft-eagle3 d2 | 28.24 | 30.51 | 36.71 | 17.51 | 806.3 | 0.407 | 6853 | yes |
| plus-ngram | 11 | draft-eagle3,ngram-mod d3 | 52.5 | 38.76 | 96.63 | 22.11 | 798.3 | 0.46 | 6848 |  |
| nospec-6 | 6 | none | 42.94 | 44.27 | 43.09 | 41.47 | 1214.9 | None | 7165 | yes |
| ngram-only-6 | 6 | ngram-mod d16 | 67.79 | 43.07 | 94.38 | 65.91 | 1119.6 | 0.66 | 7178 | yes |
| nospec-7 | 7 | none | 42.68 | 44.23 | 42.3 | 41.5 | 1124.7 | None | 6918 | yes |
| ngram-only-7 | 7 | ngram-mod d16 | 85.04 | 43.54 | 122.8 | 88.78 | 1129.7 | 0.731 | 6931 |  |
| nospec-8 | 8 | none | 40.12 | 40.66 | 40.2 | 39.51 | 1040.2 | None | 6613 | yes |
| ngram-only-8 | 8 | ngram-mod d16 | 63.27 | 42.54 | 100.23 | 47.04 | 1114.4 | 0.563 | 6595 | yes |
| experts3 | 11 | draft-eagle3 d3 | 33.89 | 38.55 | 44.46 | 18.67 | 851.8 | 0.319 | 6823 |  |
| ub1024 | 11 | draft-eagle3 d3 | 26.77 | 30.72 | 34.46 | 15.12 | 719.2 | 0.331 | 7176 |  |
| combined:ngram-mod:7:16: | 7 | ngram-mod d16 | 86.87 | 44.71 | 125.91 | 90.0 | 1160.1 | 0.731 | 6929 |  |

### Sampling sweep (tier2b at each speed-lab winner)

| Model | Sampling | Settings | Score | A | B | C | D | E | Minutes |
|---|---|---|---|---|---|---|---|---|---|
| gptoss20b | base | `{"temperature": 0.2, "top_p": 0.95}` | 107/117 | 34/36 | 14/21 | 21/21 | 20/21 | 18/18 | 16.9 |
| gptoss20b | card | `{"temperature": 1.0, "top_p": 1.0}` | 107/117 | 35/36 | 14/21 | 21/21 | 20/21 | 17/18 | 18.4 |
| gptoss20b | greedy | `{"temperature": 0.0}` | 108/117 | 35/36 | 14/21 | 21/21 | 20/21 | 18/18 | 14.3 |
| gemma26b | base | `{"temperature": 0.2, "top_p": 0.95}` | 103/117 | 32/36 | 14/21 | 21/21 | 18/21 | 18/18 | 4.9 |
| gemma26b | card | `{"temperature": 1.0, "top_p": 0.95, "top_k": 64}` | 102/117 | 32/36 | 13/21 | 21/21 | 18/21 | 18/18 | 6.3 |
| gemma26b | greedy | `{"temperature": 0.0}` | 105/117 | 33/36 | 15/21 | 21/21 | 18/21 | 18/18 | 5.7 |
| qwen36keep96 | base | `{"temperature": 0.2, "top_p": 0.95}` | 101/117 | 36/36 | 6/21 | 21/21 | 20/21 | 18/18 | 1.7 |
| qwen36keep96 | card | `{"temperature": 0.7, "top_p": 0.8, "top_k": 20, "min_p": 0.0, "presence_penalty": 1.5}` | 93/117 | 32/36 | 10/21 | 19/21 | 15/21 | 17/18 | 2.2 |
| qwen36keep96 | card-nopp | `{"temperature": 0.7, "top_p": 0.8, "top_k": 20, "min_p": 0.0}` | 95/117 | 35/36 | 6/21 | 20/21 | 20/21 | 14/18 | 2.0 |
| qwen36keep96 | greedy | `{"temperature": 0.0}` | 93/117 | 36/36 | 0/21 | 18/21 | 21/21 | 18/18 | 1.4 |
| gptoss20b-keep24 | base | `{"temperature": 0.2, "top_p": 0.95}` | 103/117 | 35/36 | 11/21 | 21/21 | 20/21 | 16/18 | 12.8 |
| gptoss20b-keep24 | card | `{"temperature": 1.0, "top_p": 1.0}` | 102/117 | 33/36 | 9/21 | 21/21 | 21/21 | 18/18 | 8.3 |
| gptoss20b-keep24 | greedy | `{"temperature": 0.0}` | 105/117 | 36/36 | 10/21 | 21/21 | 21/21 | 17/18 | 10.6 |

