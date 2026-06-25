# Analytics Infra

`analyticsInfra` is the Ploinky-managed Umami application.

It runs `docker.umami.is/umami-software/umami:postgresql-latest`, joins the `analytics` network as `analytics-umami`, and depends on `analyticsDB`.

The Umami dashboard is bound on the host at:

```text
http://127.0.0.1:3000
```

`analyticsAgent` reaches the API internally at `http://analytics-umami:3000`.
