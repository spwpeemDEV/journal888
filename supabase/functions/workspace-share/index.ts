import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const body = await req.json()
    if (body?.action === 'read') {
      const token = String(body?.token || '')
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: 'invalid_share_link' }, 404)
      const hash = await tokenHash(token)
      const { data: share, error: shareError } = await admin.from('workspace_shares')
        .select('workspace_id')
        .eq('token_hash', hash)
        .is('revoked_at', null)
        .maybeSingle()
      if (shareError || !share) return json({ error: 'share_link_not_found_or_revoked' }, 404)

      const { data: workspace, error: workspaceError } = await admin.from('workspaces')
        .select('id, name')
        .eq('id', share.workspace_id)
        .maybeSingle()
      if (workspaceError || !workspace) return json({ error: 'share_link_not_found_or_revoked' }, 404)

      const { data: trades, error: tradesError } = await admin.from('trades')
        .select('id, instrument, trade_date, trade_time, missed_entry, direction, quantity, entry, exit, stop, target, max_rr, fees, cfd_multiplier, setup, poi')
        .eq('workspace_id', workspace.id)
        .order('trade_date', { ascending: false })
        .order('trade_time', { ascending: false })
        .limit(2000)
      if (tradesError) return json({ error: 'unable_to_load_shared_trades' }, 500)
      return json({ workspace, trades: trades || [] })
    }

    const authorization = req.headers.get('Authorization') || ''
    const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!accessToken) return json({ error: 'sign_in_required' }, 401)
    const { data: authData, error: authError } = await admin.auth.getUser(accessToken)
    if (authError || !authData.user) return json({ error: 'invalid_session' }, 401)

    const workspaceId = String(body?.workspaceId || '')
    if (!workspaceId) return json({ error: 'workspace_required' }, 400)
    const { data: workspace, error: ownerError } = await admin.from('workspaces')
      .select('id')
      .eq('id', workspaceId)
      .eq('user_id', authData.user.id)
      .maybeSingle()
    if (ownerError || !workspace) return json({ error: 'workspace_not_found' }, 404)

    if (body?.action === 'revoke') {
      const { data: deleted, error } = await admin.from('workspace_shares')
        .delete()
        .eq('workspace_id', workspaceId)
        .select('id')
        .maybeSingle()
      if (error) return json({ error: 'unable_to_revoke_share' }, 500)
      return json({ revoked: Boolean(deleted) })
    }
    if (body?.action !== 'create') return json({ error: 'invalid_action' }, 400)

    const token = randomToken()
    const { error: saveError } = await admin.from('workspace_shares').upsert({
      workspace_id: workspaceId,
      token_hash: await tokenHash(token),
      created_by: authData.user.id,
      revoked_at: null,
    }, { onConflict: 'workspace_id' })
    if (saveError) return json({ error: 'unable_to_create_share' }, 500)
    return json({ token })
  } catch (error) {
    console.error('workspace-share failed:', error)
    return json({ error: 'unexpected_error' }, 500)
  }
})
