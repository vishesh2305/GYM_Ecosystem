# Backup and restore-drill tasks: PostgreSQL 17 client and server (the drill restores into a throwaway
# server), the AWS CLI for the backups bucket, bash and jq. Build: docker build infra/backup
FROM postgres:17-alpine
RUN apk add --no-cache bash jq aws-cli
COPY backup.sh restore-drill.sh /usr/local/bin/
USER postgres
WORKDIR /tmp
ENTRYPOINT []
CMD ["backup.sh"]
