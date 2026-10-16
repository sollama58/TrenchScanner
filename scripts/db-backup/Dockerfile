# The nightly full-database backup (render.yaml: trenchscanner-db-backup) and its restore tool.
# pg_dump 18 reads any server from 9.2 up to 18; backup.sh refuses a newer server rather than
# writing a dump it might not read back. aws-cli streams to and from any S3-compatible bucket
# (Cloudflare R2 here), so a dump never touches this container's disk.
FROM postgres:18-alpine
RUN apk add --no-cache bash aws-cli coreutils
WORKDIR /app
COPY common.sh backup.sh restore.sh ./
RUN chmod +x backup.sh restore.sh
# No server runs in this image: the base image's entrypoint would start one.
ENTRYPOINT []
CMD ["/app/backup.sh"]
