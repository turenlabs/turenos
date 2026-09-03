import type { ExtensionItem } from "@turenlabs/sdk/v2/client"
import { Icon } from "@turenlabs/ui/v2/icon"
import onePassword from "simple-icons/icons/1password.svg"
import atlassian from "simple-icons/icons/atlassian.svg"
import chainguard from "simple-icons/icons/chainguard.svg"
import cloudflare from "simple-icons/icons/cloudflare.svg"
import datadog from "simple-icons/icons/datadog.svg"
import elastic from "simple-icons/icons/elastic.svg"
import github from "simple-icons/icons/github.svg"
import gitlab from "simple-icons/icons/gitlab.svg"
import google from "simple-icons/icons/google.svg"
import grafana from "simple-icons/icons/grafana.svg"
import haveIBeenPwned from "simple-icons/icons/haveibeenpwned.svg"
import jfrog from "simple-icons/icons/jfrog.svg"
import kaliLinux from "simple-icons/icons/kalilinux.svg"
import notion from "simple-icons/icons/notion.svg"
import pagerDuty from "simple-icons/icons/pagerduty.svg"
import sentry from "simple-icons/icons/sentry.svg"
import snyk from "simple-icons/icons/snyk.svg"
import socket from "simple-icons/icons/socket.svg"
import sonarQubeCloud from "simple-icons/icons/sonarqubecloud.svg"
import sonarQubeServer from "simple-icons/icons/sonarqubeserver.svg"
import trivy from "simple-icons/icons/trivy.svg"
import torproject from "simple-icons/icons/torproject.svg"
import { Show } from "solid-js"

type IconName = Parameters<typeof Icon>[0]["name"]

const brands: Readonly<Record<string, { readonly source: string; readonly name: string }>> = {
  "turenlabs/atlassian-security-context": { source: atlassian, name: "Atlassian" },
  "turenlabs/chainguard-docs": { source: chainguard, name: "Chainguard" },
  "turenlabs/cloudflare-audit-logs": { source: cloudflare, name: "Cloudflare" },
  "turenlabs/cloudflare-casb": { source: cloudflare, name: "Cloudflare" },
  "turenlabs/datadog-security": { source: datadog, name: "Datadog" },
  "turenlabs/datadog-malicious": { source: datadog, name: "Datadog" },
  "turenlabs/depsdev": { source: google, name: "Google" },
  "turenlabs/elastic-security": { source: elastic, name: "Elastic" },
  "turenlabs/exploitdb": { source: kaliLinux, name: "Kali Linux" },
  "turenlabs/github-security": { source: github, name: "GitHub" },
  "turenlabs/ghsa": { source: github, name: "GitHub" },
  "turenlabs/gitlab-devsecops": { source: gitlab, name: "GitLab" },
  "turenlabs/grafana-cloud-security": { source: grafana, name: "Grafana" },
  "turenlabs/hibp": { source: haveIBeenPwned, name: "Have I Been Pwned" },
  "turenlabs/jfrog-xray": { source: jfrog, name: "JFrog" },
  "turenlabs/notion": { source: notion, name: "Notion" },
  "turenlabs/onepassword": { source: onePassword, name: "1Password" },
  "turenlabs/osv": { source: google, name: "Google" },
  "turenlabs/pagerduty": { source: pagerDuty, name: "PagerDuty" },
  "turenlabs/sentry": { source: sentry, name: "Sentry" },
  "turenlabs/snyk-local": { source: snyk, name: "Snyk" },
  "turenlabs/socket": { source: socket, name: "Socket" },
  "turenlabs/sonarqube-cloud-security": { source: sonarQubeCloud, name: "SonarQube Cloud" },
  "turenlabs/sonarqube-server": { source: sonarQubeServer, name: "SonarQube Server" },
  "turenlabs/trivy-local": { source: trivy, name: "Trivy" },
  "turenlabs/tor-exit": { source: torproject, name: "Tor Project" },
}

export function ExtensionLogo(props: {
  readonly item: ExtensionItem
  readonly fallback: IconName
  readonly size?: "card" | "dialog"
}) {
  const brand = () => brands[props.item.manifest.id]
  const automox = () =>
    props.item.manifest.id === "turenlabs/automox" || props.item.manifest.id === "turenlabs/automox-local"
  const crowdStrike = () => props.item.manifest.id === "turenlabs/crowdstrike-falcon"
  const microsoft = () => props.item.manifest.id === "turenlabs/microsoft-sentinel"
  const aws = () =>
    props.item.manifest.id === "turenlabs/aws-cloudtrail-local" ||
    props.item.manifest.id === "turenlabs/aws-well-architected-security-local"
  const branded = () => Boolean(brand() || automox() || crowdStrike() || microsoft() || aws())
  const fallback = () => {
    if (automox()) return <AutomoxLogo />
    if (crowdStrike()) return <CrowdStrikeLogo />
    if (microsoft()) return <MicrosoftLogo />
    if (aws()) return <AwsLogo />
    return <Icon name={props.fallback} class="size-4.5" />
  }
  return (
    <span
      class="inline-flex shrink-0 items-center justify-center overflow-hidden border shadow-sm"
      classList={{
        "size-9 rounded-lg": props.size !== "dialog",
        "size-11 rounded-xl": props.size === "dialog",
        "border-v2-border-border-base bg-v2-background-bg-base text-v2-text-text-base": branded(),
        "border-v2-icon-icon-accent/20 bg-gradient-to-br from-v2-background-bg-base to-v2-background-bg-surface":
          !branded(),
      }}
    >
      <Show when={brand()} fallback={fallback()}>
        {(icon) => (
          <span
            role="img"
            aria-label={`${icon().name} logo`}
            class="size-5"
            style={{
              "background-color": "var(--v2-icon-icon-base)",
              "mask-image": `url(${icon().source})`,
              "mask-position": "center",
              "mask-repeat": "no-repeat",
              "mask-size": "contain",
              "-webkit-mask-image": `url(${icon().source})`,
              "-webkit-mask-position": "center",
              "-webkit-mask-repeat": "no-repeat",
              "-webkit-mask-size": "contain",
            }}
          />
        )}
      </Show>
    </span>
  )
}

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Microsoft logo" class="size-5">
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M13 1h10v10H13z" />
      <path fill="#00A4EF" d="M1 13h10v10H1z" />
      <path fill="#FFB900" d="M13 13h10v10H13z" />
    </svg>
  )
}

function AwsLogo() {
  return (
    <svg viewBox="0 0 36 24" role="img" aria-label="AWS logo" class="h-6 w-8">
      <text
        x="3"
        y="15"
        fill="var(--v2-icon-icon-base)"
        font-family="Arial, sans-serif"
        font-size="14"
        font-weight="700"
      >
        aws
      </text>
      <path fill="none" stroke="#FF9900" stroke-linecap="round" stroke-width="2" d="M7 19c7 4 17 4 24-1" />
      <path fill="#FF9900" d="m27.5 16.5 5 .5-2.7 4.2Z" />
    </svg>
  )
}

function CrowdStrikeLogo() {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label="CrowdStrike logo" class="size-6">
      <g fill="#FC0000">
        <g transform="translate(13 3.527)">
          <path d="M14.52 12.24v-.307l-2.6-2.238h-.303c-.715.79-1.819 1.382-3.054 1.382-1.928 0-3.445-1.47-3.445-3.488s1.517-3.488 3.445-3.488c1.235 0 2.339.592 3.054 1.382h.303l2.6-2.238v-.307C13.155 1.291 11.011.216 8.584.216 4.122.216.743 3.375.743 7.609c0 .164.037.315.048.476 1.826 1.242 3.438 2.236 4.826 3.146 2.001 1.266 3.616 2.431 4.946 3.514 1.658-.419 3.002-1.328 3.957-2.485M2.37 12.181c1.042 1.28 2.513 2.198 4.248 2.59-1.172-.659-2.307-1.306-3.364-2.022-.31-.192-.586-.378-.884-.568" />
        </g>
        <g transform="translate(0 .527)">
          <path d="M29.82 31c-1.039-2.378-3.126-5.429-11.3-9.786-3.77-2.096-10.21-5.323-16-11.46.525 2.214 3.215 7.079 14.78 13.15 3.204 1.753 8.622 3.397 12.52 8.088" />
          <path d="M29.3 26.93c-.986-2.81-2.766-6.408-11.21-11.75C13.979 12.486 7.94 9.103 0 .48c.568 2.325 3.078 8.371 15.73 16.22 4.156 2.816 9.52 4.553 13.57 10.23" />
        </g>
      </g>
    </svg>
  )
}

function AutomoxLogo() {
  return (
    <svg viewBox="0 0 49 42" role="img" aria-label="Automox logo" class="size-6">
      <path
        fill="#009CC9"
        d="M36.0808 35.9281 26.2741 18.1276l2.0098-3.2383L42.1695 39.6084H5.9674l-2.352-3.6803h32.4654ZM9.3589 29.9824l-.0875.1411 20.836-.0313 1.8982 3.4443H3.531L21.9992 2.3916h4.2636L9.3589 29.9824Zm10.9652-2.2654 4.4884-7.2359 3.9795 7.2217-8.4679.0142Zm-2.845-.0001-3.9056.0067L28.3804 3.5571l17.8568 30.918-2.0376 3.8155-15.7333-28.0083-.0792-.1388-10.908 17.5734ZM29.7893 1.1655 29.1154 0h-8.5063L0 34.7558 4.6316 42h40.3256L49 34.4318 29.7893 1.1655Z"
      />
    </svg>
  )
}
