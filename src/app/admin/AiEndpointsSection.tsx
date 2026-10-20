'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// NIAS-59: one card per AI purpose. API keys never reach the browser — only the stored hint.
// NIAS-62: below the primary endpoint an optional fallback, tried when the primary one fails.

export type AiPurpose = 'transcription' | 'text_generation'
export type AiSlot = 'primary' | 'fallback'

export interface AiEndpointSlotStatus {
  purpose: AiPurpose
  slot: AiSlot
  source: 'database' | 'env'
  name: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKeyHint: string | null
  updatedAt: string | null
  /** Formatted on the server, so server and browser render the same text. */
  updatedAtText: string | null
}

export interface AiEndpointStatus extends AiEndpointSlotStatus {
  fallback: AiEndpointSlotStatus | null
}

type Feedback = { kind: 'success' | 'error'; text: string } | null

interface ApiResult {
  ok?: boolean
  success?: boolean
  error?: string
  code?: string
  fields?: string[]
  status?: number
  modelFound?: boolean | null
  detail?: string
}

const FIELDS = ['name', 'baseUrl', 'model', 'apiKey'] as const

export function AiEndpointsSection({ endpoints, loadError }: { endpoints: AiEndpointStatus[]; loadError: string | null }) {
  const t = useTranslations('admin.aiEndpoints')
  // Kept here: a form remounts after every save/reset (new key) so it shows the new state.
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({})
  const feedbackProps = (purpose: AiPurpose, slot: AiSlot) => ({
    feedback: feedback[`${purpose}:${slot}`] ?? null,
    setFeedback: (next: Feedback) => setFeedback((current) => ({ ...current, [`${purpose}:${slot}`]: next })),
  })
  return (
    <div>
      <div className="mt-12 mb-4">
        <h2 className="text-2xl font-bold">{t('title')}</h2>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
        {loadError && <p className="text-sm text-red-700 mt-2">{t('loadError', { error: loadError })}</p>}
      </div>
      <div className="space-y-6">
        {endpoints.map((endpoint) => (
          <Card key={endpoint.purpose}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-lg">{t(`purpose_${endpoint.purpose}`)}</CardTitle>
                {endpoint.source === 'database' ? (
                  <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{t('sourceDatabase')}</Badge>
                ) : (
                  <Badge variant="secondary">{t('sourceEnv')}</Badge>
                )}
              </div>
              <CardDescription>
                {t(`purposeHint_${endpoint.purpose}`)}
                {endpoint.updatedAtText && <> · {t('updatedAt', { date: endpoint.updatedAtText })}</>}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EndpointForm
                key={`primary:${endpoint.source}:${endpoint.updatedAt}`}
                endpoint={endpoint}
                {...feedbackProps(endpoint.purpose, 'primary')}
              />
              <FallbackBlock
                key={`fallback:${endpoint.fallback?.updatedAt ?? 'none'}`}
                endpoint={endpoint}
                {...feedbackProps(endpoint.purpose, 'fallback')}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

function FallbackBlock({ endpoint, feedback, setFeedback }: {
  endpoint: AiEndpointStatus
  feedback: Feedback
  setFeedback: (feedback: Feedback) => void
}) {
  const t = useTranslations('admin.aiEndpoints')
  const [adding, setAdding] = useState(false)
  const { fallback } = endpoint
  const blank: AiEndpointSlotStatus = {
    purpose: endpoint.purpose, slot: 'fallback', source: 'env', name: '', baseUrl: '', model: '',
    hasApiKey: false, apiKeyHint: null, updatedAt: null, updatedAtText: null,
  }

  return (
    <div className="mt-6 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="font-semibold">{t('fallbackTitle')}</h3>
        {fallback && <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{t('fallbackActive')}</Badge>}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        {t('fallbackHint')}
        {fallback?.updatedAtText && <> · {t('updatedAt', { date: fallback.updatedAtText })}</>}
      </p>
      {fallback || adding ? (
        <EndpointForm
          endpoint={fallback ?? blank}
          feedback={feedback}
          setFeedback={setFeedback}
          onCancel={fallback ? undefined : () => setAdding(false)}
        />
      ) : (
        <>
          <Button type="button" variant="outline" onClick={() => { setFeedback(null); setAdding(true) }}>
            {t('fallbackAdd')}
          </Button>
          {feedback && (
            <p role="status" className={`mt-2 text-sm ${feedback.kind === 'error' ? 'text-red-700' : 'text-green-700'}`}>
              {feedback.text}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function EndpointForm({ endpoint, feedback, setFeedback, onCancel }: {
  endpoint: AiEndpointSlotStatus
  feedback: Feedback
  setFeedback: (feedback: Feedback) => void
  /** Only for a fallback that is not stored yet: hides the empty form again. */
  onCancel?: () => void
}) {
  const t = useTranslations('admin.aiEndpoints')
  const router = useRouter()
  const [form, setForm] = useState({ name: endpoint.name, baseUrl: endpoint.baseUrl, model: endpoint.model, apiKey: '' })
  const [clearApiKey, setClearApiKey] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | 'reset' | null>(null)
  const [invalid, setInvalid] = useState<string[]>([])

  const { purpose, slot } = endpoint
  const isFallback = slot === 'fallback'
  const storedKey = endpoint.source === 'database' && endpoint.hasApiKey
  const apiKeyPlaceholder = storedKey
    ? t('apiKeyStored', { hint: endpoint.apiKeyHint ?? '…' })
    : endpoint.source === 'env' && !isFallback ? t('apiKeyEnv') : t('apiKeyNone')
  const purposeLabel = t(`purpose_${purpose}`)

  function errorText(result: ApiResult) {
    const code = result.error ?? result.code ?? 'unknown'
    if (code === 'invalid' && result.fields?.length) {
      return result.fields.map((field) => t(`error_field_${field}`)).join(' ')
    }
    if (t.has(`error_${code}`)) return t(`error_${code}`, { status: result.status ?? '', detail: result.detail ?? '' })
    return t('error_unknown')
  }

  async function call(kind: 'save' | 'test' | 'reset') {
    setBusy(kind)
    setFeedback(null)
    setInvalid([])
    try {
      const body = JSON.stringify({ purpose, slot, ...form, clearApiKey })
      const res =
        kind === 'reset'
          ? await fetch(`/api/admin/ai-endpoints?purpose=${purpose}&slot=${slot}`, { method: 'DELETE' })
          : await fetch(kind === 'save' ? '/api/admin/ai-endpoints' : '/api/admin/ai-endpoints/test', {
              method: kind === 'save' ? 'PUT' : 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            })
      const result: ApiResult = await res.json().catch(() => ({}))

      if (!res.ok || result.ok === false) {
        setInvalid(result.fields ?? [])
        setFeedback({ kind: 'error', text: errorText(result) })
        return
      }
      if (kind === 'test') {
        const model =
          result.modelFound === true ? t('testModelFound', { model: form.model })
          : result.modelFound === false ? t('testModelMissing', { model: form.model })
          : t('testModelUnknown')
        setFeedback({ kind: result.modelFound === false ? 'error' : 'success', text: `${t('testOk', { status: result.status ?? '' })} ${model}` })
        return
      }
      const done = kind === 'save' ? t('saved') : isFallback ? t('fallbackRemoved') : t('resetDone')
      setFeedback({ kind: 'success', text: done })
      setForm((current) => ({ ...current, apiKey: '' }))
      router.refresh()
    } catch {
      setFeedback({ kind: 'error', text: t('error_unknown') })
    } finally {
      setBusy(null)
    }
  }

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault()
        call('save')
      }}
    >
      {FIELDS.map((field) => {
        const id = `${purpose}-${slot}-${field}`
        const label = { name: 'fieldName', baseUrl: 'fieldBaseUrl', model: 'fieldModel', apiKey: 'fieldApiKey' }[field]
        return (
          <div key={field} className="space-y-1.5">
            <Label htmlFor={id}>{t(label)}</Label>
            <Input
              id={id}
              type={field === 'apiKey' ? 'password' : field === 'baseUrl' ? 'url' : 'text'}
              autoComplete={field === 'apiKey' ? 'new-password' : 'off'}
              value={form[field]}
              placeholder={field === 'apiKey' ? apiKeyPlaceholder : undefined}
              disabled={field === 'apiKey' && clearApiKey}
              aria-invalid={invalid.includes(field)}
              className={invalid.includes(field) ? 'border-red-500' : undefined}
              onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
            />
          </div>
        )
      })}

      <div className="sm:col-span-2 space-y-2 text-sm text-muted-foreground">
        <p>{t('apiKeyNote')}</p>
        {storedKey && (
          <label className="flex items-center gap-2">
            <Checkbox checked={clearApiKey} onCheckedChange={(checked) => setClearApiKey(checked === true)} />
            {t('clearApiKey')}
          </label>
        )}
      </div>

      <div className="sm:col-span-2 flex flex-wrap gap-2">
        <Button type="submit" disabled={busy !== null}>
          {busy === 'save' ? t('saving') : t('save')}
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={() => call('test')}>
          {busy === 'test' ? t('testing') : t('test')}
        </Button>
        {endpoint.source === 'database' && (
          <Button
            type="button"
            variant="outline"
            className="text-red-700 border-red-300 hover:bg-red-50 hover:text-red-800"
            disabled={busy !== null}
            onClick={() => {
              const question = isFallback ? t('fallbackRemoveConfirm', { purpose: purposeLabel }) : t('resetConfirm', { purpose: purposeLabel })
              if (confirm(question)) call('reset')
            }}
          >
            {isFallback ? t('fallbackRemove') : t('reset')}
          </Button>
        )}
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy !== null} onClick={onCancel}>
            {t('cancel')}
          </Button>
        )}
      </div>

      {feedback && (
        <p role="status" className={`sm:col-span-2 text-sm ${feedback.kind === 'error' ? 'text-red-700' : 'text-green-700'}`}>
          {feedback.text}
        </p>
      )}
    </form>
  )
}
