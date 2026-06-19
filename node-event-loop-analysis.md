1→# Node.js High-Latency Event Loop Analysis
2→
3→## Objective
4→Investigate a high-latency Node.js event loop by collecting runtime details, measuring event-loop lag, capturing process health, profiling the process, and identifying likely blocking or inefficient code paths.
5→
6→## 1. Define the latency symptom
7→
8→Collect or confirm the following before profiling:
9→
10→- Affected surface: HTTP endpoints, background jobs, WebSocket handlers, cron jobs, message consumers, or startup tasks.
11→- Latency threshold: example, p95/p99 request latency above 1s, 5s, or a specific SLO.
12→- Frequency: always, intermittent, spikes, after deployments, during traffic bursts, or during scheduled jobs.
13→- Duration: seconds, minutes, or continuous.
14→- User impact: failed requests, timeouts, queue lag, dropped messages, degraded UI, or downstream SLA breaches.
15→- Time window: start/end time and timezone.
16→- Environment: production, staging, or local reproduction.
17→
18→If these are not already known, capture them from APM, load balancer logs, reverse proxy logs, application logs, and queue metrics.
19→
20→## 2. Capture Node.js runtime details
21→
22→Record:
23→
24→```bash
25→node -v
26→npm -v
27→yarn -v 2>/dev/null || true
28→pnpm -v 2>/dev/null || true
29→uname -a
30→cat /etc/os-release 2>/dev/null || true
31→nproc
32→free -m
33→df -h
34→```
35→
36→If containerized:
37→
38→```bash
39→docker inspect <container_id> | jq '.[0].Config.Env, .[0].HostConfig'
40→kubectl describe pod <pod_name> -n <namespace>
41→kubectl get pod <pod_name> -n <namespace> -o jsonpath='{.spec.containers[*].resources}'
42→```
43→
44→Record:
45→
46→- Node.js version and architecture.
47→- Process manager: PM2, systemd, Kubernetes, Docker, ECS, Lambda, etc.
48→- Worker count / cluster mode.
49→- CPU and memory limits.
50→- Node flags, especially `--max-old-space-size`, `--expose-gc`, `--trace-gc`, `--heapsnapshot-near-heap-limit`, `--inspect`.
51→- Current working directory and app entrypoint.
52→- Deployment version / git SHA.
53→
54→## 3. Reproduce the issue in a controlled environment
55→
56→Create a minimal workload that exercises the affected path.
57→
58→Examples:
59→
60→```bash
61→# HTTP endpoint load test
62→npx autocannon -c 100 -d 120 -p 10 http://localhost:3000/slow-endpoint
63→
64→# Background job stress test
65→node scripts/run-job-stress.js
66→```
67→
68→If production-only data is required, reproduce in staging with production-like:
69→
70→- Node version.
71→- CPU/memory limits.
72→- Database size or seeded data volume.
73→- Queue depth.
74→- Traffic pattern.
75→- Feature flags.
76→- Third-party service mocks or realistic mocks.
77→
78→## 4. Measure event-loop lag
79→
80→Add temporary instrumentation near application startup: