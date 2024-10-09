# Best practices from https://snyk.io/blog/10-best-practices-to-containerize-nodejs-web-applications-with-docker/

ARG NODE_VERSION=20.17.0

# --------------> The build image__
FROM node:${NODE_VERSION} AS build
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init
WORKDIR /usr/src/app
COPY package*.json /usr/src/app/
# TODO: Remove this line when the package is published
COPY comapeo-schema-server.tgz /usr/src/app/
RUN npm ci --omit=dev

# --------------> The production image__
FROM node:${NODE_VERSION}-bullseye-slim

ENV NODE_ENV production
ENV PORT 8080
EXPOSE 8080
COPY --from=build /usr/bin/dumb-init /usr/bin/dumb-init
USER node
WORKDIR /usr/src/app
COPY --chown=node:node --from=build /usr/src/app/node_modules /usr/src/app/node_modules
COPY --chown=node:node . /usr/src/app
CMD ["dumb-init", "node", "src/server/server.js"]
