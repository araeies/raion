/**
 * Container images of the observability runtime, pinned by digest (multi-arch index).
 *
 * Tags are kept for readability; the digest is what Docker actually pulls, so a re-tagged
 * or tampered image can never be deployed silently. Update with `node scripts/update-images.mjs`,
 * which resolves digests from the registries, then review the upstream release notes.
 */
export const IMAGES = {
  'otel-collector': {
    image: 'otel/opentelemetry-collector-contrib',
    tag: '0.161.0',
    digest: 'sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1',
  },
  prometheus: {
    image: 'prom/prometheus',
    tag: 'v3.13.4',
    digest: 'sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e',
  },
  alertmanager: {
    image: 'prom/alertmanager',
    tag: 'v0.34.1',
    digest: 'sha256:e9733bafb1bdef9b00e25a21f8f99dc26a22224bf16641ad754d1649f4c3357a',
  },
  'node-exporter': {
    image: 'prom/node-exporter',
    tag: 'v1.12.1',
    digest: 'sha256:1b4e4438faca4dd7e001dd445d161a4a2091b0fededa84093b3a8dfeae1f1be0',
  },
  grafana: {
    image: 'grafana/grafana',
    tag: '13.2.3',
    digest: 'sha256:b28bae15e219c998fb0e0424ed724930cc61b1f61fb404d47c862f9a23f9e572',
  },
  loki: {
    image: 'grafana/loki',
    tag: '3.7.8',
    digest: 'sha256:1107dd5274e0ada47e42472b7a7e71f3b2a2fe878878108f3e2f9e51528f0193',
  },
  tempo: {
    image: 'grafana/tempo',
    tag: '3.1.0',
    digest: 'sha256:3076b8dcdfb32fd6bc5ccef85e7b7313e6199b9cb84366257fc17ecb696db5fd',
  },
  gateway: {
    image: 'nginxinc/nginx-unprivileged',
    tag: '1.30.4-alpine',
    digest: 'sha256:adf5042a17f4ecdd200c595fa9ffd1be37efb18f89a830bd1a00e4ab4d59d42c',
  },
  cadvisor: {
    image: 'ghcr.io/google/cadvisor',
    tag: 'v0.60.6',
    digest: 'sha256:b8e7d1093144fd088f425ff003d75a4aa405de075db78dae3bc563730b1bd07a',
  },
} as const satisfies Record<string, { image: string; tag: string; digest: string }>;

export type ComponentId = keyof typeof IMAGES;

export function imageRef(component: ComponentId): string {
  const { image, tag, digest } = IMAGES[component];
  return `${image}:${tag}@${digest}`;
}
