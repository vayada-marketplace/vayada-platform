FROM docker.io/library/python@sha256:c4634f578a412db396771b61b064c6e546c9d6414c7fb5b1b05d5871f1885f7b
ARG FIXTURE_VARIANT
RUN python -c 'import sys; from pathlib import Path; variant = sys.argv[1]; assert variant in {"baseline", "good", "bad"}; Path("/fixture-variant").write_text(variant)' "$FIXTURE_VARIANT"
COPY scenario_app.py /fixture.py
USER 65534:65534
ENTRYPOINT ["python", "-B", "-u", "/fixture.py"]
