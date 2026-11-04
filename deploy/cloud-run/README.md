# Cloud Tasks / Cloud Run audio worker (template)

`audio-worker.service.yaml` is a deployment template, not an applied service. API and Worker reuse the validated Docker image; set `ARVC_SERVICE_ROLE=api` for the API and `worker` for this private worker. Worker starts no polling loop and only exposes health plus the authenticated task endpoint. API must use `AUDIO_ANALYSIS_TRANSPORT=cloud_tasks`; local mode keeps its existing DB poller.

Grant `roles/run.invoker` on the worker only to the Cloud Tasks OIDC service account. API and Worker runtime identities need queue task creation permission and `roles/iam.serviceAccountUser` on the OIDC identity because both can enqueue (the Worker wakes the next job). The Cloud Tasks service agent must retain its Google-managed service-agent role. The task OIDC identity itself needs no database access. API/Worker runtime identities need only their database secret/network access and Cloud Tasks enqueue rights. Keep Cloud Run unauthenticated access disabled. The application also validates Google OIDC issuer, audience, expiry, and exact service-account email.

Configure Cloud Tasks `maxConcurrentDispatches=2` and `maxDispatchesPerSecond=2`. PostgreSQL claim remains the concurrency authority. Configure retry backoff and retention so task retries do not outlive the 15-minute DB job lease without a DB lease recovery path. The application has a transactional outbox and deterministic task names; a periodic Cloud Scheduler POST to `/internal/jobs/dispatch` with a distinct OIDC service account/audience is required to recover enqueue outages while API and Worker are at min instances 0. Worker completion also dispatches the next available queued jobs.

Deadlines must be kept aligned: Cloud Run request timeout 780s, task dispatch deadline 720s, job lease 900s, SCNet analysis timeout 600s. The Cloud Tasks real service and Cloud Scheduler are intentionally not configured or called in this step.

## Hosted Supabase Free suitability

Do not enable this path on Free as-is. The queued audio is stored in PostgreSQL (`bytea`), and the Free database allocation is 500 MB; the current admission bound permits up to 320 MiB queued audio before results, indexes, and existing project data. Free projects can pause after inactivity and do not provide automatic backups. Before Hosted use, move temporary media/results to private object storage with TTL or tighten aggregate queue/result bytes below a measured DB budget, verify pooled connection limits, and establish independent backup/restore readiness. No hosted connection or change was performed.
