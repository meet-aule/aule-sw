# Build from the repository root: docker build -f apps/playground/Dockerfile .
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS deps
RUN npm install --global pnpm@12.21.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json contracts/
COPY apps/playground/package.json apps/playground/
RUN pnpm install --frozen-lockfile --prod --filter @aule/playground

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ENV NODE_ENV=production
COPY --from=deps /repo /repo
WORKDIR /repo/apps/playground
COPY apps/playground/src ./src
COPY apps/playground/public ./public
USER node
# The commit it is built from (RELEASING.md). Last, so a new one rebuilds no layer.
ARG AULE_COMMIT=unknown
ENV AULE_COMMIT=$AULE_COMMIT
CMD ["node", "src/server.ts"]
