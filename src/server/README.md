## Deploying CoMapeo Cloud

CoMapeo Cloud comes with a [`Dockerfile`](../../Dockerfile) that can be used to build a Docker image. This image can be used to deploy CoMapeo Cloud on a server.

Server configuration is done using environment variables. The following environment variables are available:

| Environment Variable  | Required | Description                                                          | Default Value    |
| --------------------- | -------- | -------------------------------------------------------------------- | ---------------- |
| `SERVER_BEARER_TOKEN` | Yes      | Token for authenticating API requests. Should be large random string |                  |
| `PORT`                | No       | Port on which the server runs                                        | `8080`           |
| `SERVER_NAME`         | No       | Friendly server name, seen by users when adding server               | `CoMapeo Server` |
| `ALLOWED_PROJECTS`    | No       | Number of projects allowed to register with the server               | `1`              |
| `STORAGE_DIR`         | No       | Path for storing app & project data                                  | `$CWD/data`      |

### Deploying with fly.io

CoMapeo Cloud can be deployed on [fly.io](https://fly.io) using the following steps:

1. Install the flyctl CLI tool by following the instructions [here](https://fly.io/docs/getting-started/installing-flyctl/).
2. Create a new app on fly.io by running `flyctl apps create`, take a note of the app name.
3. Set the SERVER_BEARER_TOKEN secret via:
   ```sh
   flyctl secrets set SERVER_BEARER_TOKEN=<your-secret> --app <your-app-name>
   ```
4. Deploy the app by running (optionally setting the `ALLOWED_PROJECTS` environment variable):
   ```sh
   flyctl deploy --app <your-app-name> -e ALLOWED_PROJECTS=10
   ```
5. The app should now be running on fly.io. You can access it at `https://<your-app-name>.fly.dev`.

To destroy the app (delete all data and project invites), run:

> [!WARNING]
> This action is irreversible and will permanently delete all data associated with the app, and projects that have already added the server will no longer be able to sync with it.

```sh
flyctl destroy --app <your-app-name>
```
