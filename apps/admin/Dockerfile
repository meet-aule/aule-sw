# Build from the repository root: docker build -f apps/admin/Dockerfile .
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS deps
RUN npm install --global pnpm@12.21.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Only the console's own manifest: pnpm installs a filtered package without the other workspaces'.
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --prod --filter @aule/admin

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ENV NODE_ENV=production
COPY --from=deps /repo /repo
WORKDIR /repo/apps/admin
COPY apps/admin/src ./src
COPY apps/admin/public ./public
USER node
# The commit it is built from (RELEASING.md). Last, so a new one rebuilds no layer.
ARG AULE_COMMIT=unknown
ENV AULE_COMMIT=$AULE_COMMIT
# Only the settings the console reads reach its process (src/config.ts lists the same names). The env file
# every service shares also holds the operator's token, the database's password and the LiveKit secret.
CMD ["/bin/sh", "-c", "exec env -i PATH=\"$PATH\" NODE_ENV=production AULE_COMMIT=\"$AULE_COMMIT\" ADMIN_HOST=\"$ADMIN_HOST\" ADMIN_PORT=\"$ADMIN_PORT\" ADMIN_PUBLIC_URL=\"$ADMIN_PUBLIC_URL\" ADMIN_EDGE_SECRET=\"$ADMIN_EDGE_SECRET\" AULE_PLATFORM_URL=\"$AULE_PLATFORM_URL\" AULE_ADMIN_EMAILS=\"$AULE_ADMIN_EMAILS\" node src/server.ts"]
