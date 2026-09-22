FROM n8nio/n8n:latest
USER root
COPY n8n/TARA_VIORA_ALL_WORKFLOWS.json /opt/tara-viora/workflows.json
COPY n8n-runtime/start.sh /opt/tara-viora/start.sh
RUN chmod +x /opt/tara-viora/start.sh
ENTRYPOINT ["/bin/sh","/opt/tara-viora/start.sh"]
