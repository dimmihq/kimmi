import { Send } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useSendDigest, useTestWebhook } from '@/api/analytics';
import { errorMessage } from '@/api/http';
import { useMe, useProject } from '@/api/queries';
import { canManage, useProjectSettings, useUpdateProjectSettings } from '@/api/settings';
import type { AlertSettings as Alerts } from '@/api/types';
import {
  Button,
  Input,
  Page,
  SettingRow,
  SettingSection,
  SettingsHeader,
  Switch,
  toast,
} from '@/ui';
import { failed, Loaded, SavingInput, SectionError } from '../settings/parts';

/** What the server sends in place of the webhook to people who are not admins. */
const HIDDEN = 'hidden';

const code = (text: string) => <code className="font-mono text-mono text-fg-muted">{text}</code>;

const SPIKES = [
  {
    id: 'errorSpike',
    title: 'Error spike',
    hint: 'When this many errors happen within an hour. 0 turns it off.',
    suffix: 'errors in an hour',
  },
  {
    id: 'rageSpike',
    title: 'Rage click spike',
    hint: 'When this many rage clicks happen within an hour. 0 turns it off.',
    suffix: 'rage clicks in an hour',
  },
] as const;

type SwitchField = 'newErrors' | 'noTraffic' | 'feedback' | 'weeklyDigest';

export function AlertSettings() {
  const { projectId = '' } = useParams();
  const manage = canManage(useMe().data?.user.role);
  const project = useProject(projectId);
  const settings = useProjectSettings(projectId);
  const update = useUpdateProjectSettings(projectId);
  const testWebhook = useTestWebhook(projectId);
  const sendDigest = useSendDigest(projectId);
  const alerts = settings.data?.alerts;

  const hasUrl = Boolean(alerts && alerts.webhookUrl !== '' && alerts.webhookUrl !== HIDDEN);
  const canSend = manage && hasUrl;

  /** Switches apply at once, shown before the server answers. */
  const save = (patch: Partial<Alerts>) =>
    update.mutate({ alerts: patch }, { onSuccess: () => toast('Saved'), onError: failed });

  const toggle = (id: SwitchField, title: string, description: string) => (
    <SettingRow title={title} description={description}>
      <Loaded value={alerts} kind="switch">
        {(current) => (
          <Switch
            label={title}
            disabled={!manage}
            checked={current[id]}
            onChange={(next) => save({ [id]: next })}
          />
        )}
      </Loaded>
    </SettingRow>
  );

  return (
    <Page>
      <SettingsHeader
        title="Alerts"
        description={`Where kimmi sends a message when something happens on ${project.data?.name ?? 'this project'}.`}
      />

      {settings.isError ? (
        <SectionError
          title="Webhook"
          description="Every alert and the weekly digest are posted to this address."
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <>
          <SettingSection
            title="Webhook"
            description="Every alert and the weekly digest are posted to this address."
          >
            <SettingRow
              wide
              title="Webhook URL"
              description="Leave it empty and nothing is sent."
              htmlFor="alerts-webhook"
            >
              <Loaded value={alerts}>
                {(current) =>
                  current.webhookUrl === HIDDEN ? (
                    <Input
                      id="alerts-webhook"
                      disabled
                      readOnly
                      value=""
                      placeholder="Only admins can see the webhook"
                    />
                  ) : (
                    <SavingInput
                      id="alerts-webhook"
                      mono
                      type="url"
                      field="alerts.webhookUrl"
                      placeholder="https://example.com/hooks/kimmi"
                      disabled={!manage}
                      value={current.webhookUrl}
                      onSave={(next) =>
                        update.mutateAsync({ alerts: { webhookUrl: next.trim() } })
                      }
                    />
                  )
                }
              </Loaded>
            </SettingRow>
            <SettingRow
              wide
              title="Signing secret"
              description={
                <>
                  When set, each delivery carries{' '}
                  {code('X-Kimmi-Signature: sha256=<hmac of the body>')}.
                </>
              }
              htmlFor="alerts-secret"
            >
              <Loaded value={alerts}>
                {(current) => (
                  <SavingInput
                    id="alerts-secret"
                    mono
                    type="password"
                    autoComplete="off"
                    field="alerts.secret"
                    disabled={!manage}
                    value={current.secret}
                    onSave={(next) => update.mutateAsync({ alerts: { secret: next } })}
                  />
                )}
              </Loaded>
            </SettingRow>
            <SettingRow
              title="Send a test"
              description="Posts a sample event to the webhook."
            >
              <Button
                icon={Send}
                disabled={!canSend || testWebhook.isPending}
                onClick={() => testWebhook.mutate(undefined, { onSuccess: () => toast('Delivered') })}
              >
                Send test
              </Button>
              {testWebhook.isError ? (
                <p role="alert" className="mt-1.5 text-hint text-danger-fg">
                  {errorMessage(testWebhook.error)}
                </p>
              ) : null}
            </SettingRow>
          </SettingSection>

          <p className="mt-3 text-meta text-fg-meta">
            kimmi posts one JSON object per event: {code('event')}, {code('project')}, {code('at')},{' '}
            {code('title')}, {code('text')}, {code('url')} and {code('data')}.
          </p>

          <SettingSection title="Alerts" description="What kimmi tells the webhook about.">
            {toggle('newErrors', 'New errors', 'The first time a kind of error is seen.')}
            {SPIKES.map((entry) => (
              <SettingRow
                key={entry.id}
                title={entry.title}
                description={entry.hint}
                htmlFor={`alerts-${entry.id}`}
              >
                <Loaded value={alerts}>
                  {(current) => (
                    // The field, what it counts beside it, and the server's message under both.
                    <div className="grid grid-cols-[5rem_1fr] items-center gap-x-2.5 [&>p]:order-last [&>p]:col-span-2">
                      <SavingInput
                        id={`alerts-${entry.id}`}
                        type="number"
                        min={0}
                        inputMode="numeric"
                        placeholder="0"
                        className="tabular"
                        field={`alerts.${entry.id}`}
                        disabled={!manage}
                        value={String(current[entry.id])}
                        onSave={(next) =>
                          update.mutateAsync({
                            alerts: { [entry.id]: Math.max(0, Math.round(Number(next) || 0)) },
                          })
                        }
                      />
                      <span className="text-control text-fg-meta">{entry.suffix}</span>
                    </div>
                  )}
                </Loaded>
              </SettingRow>
            ))}
            {toggle('noTraffic', 'No visits for a day', 'When a full day passes without a visit.')}
            {toggle('feedback', 'Feedback', 'When a visitor sends feedback.')}
          </SettingSection>

          <SettingSection title="Weekly digest">
            {toggle(
              'weeklyDigest',
              'Send every Monday',
              "A summary of the last seven days, Monday morning in the project's time zone.",
            )}
            <SettingRow
              title="Send it now"
              description="Posts the digest for the last seven days to the webhook."
            >
              <Button
                icon={Send}
                disabled={!canSend || sendDigest.isPending}
                onClick={() => sendDigest.mutate(undefined, { onSuccess: () => toast('Sent') })}
              >
                Send digest
              </Button>
              {sendDigest.isError ? (
                <p role="alert" className="mt-1.5 text-hint text-danger-fg">
                  {errorMessage(sendDigest.error)}
                </p>
              ) : null}
            </SettingRow>
          </SettingSection>
        </>
      )}
    </Page>
  );
}
