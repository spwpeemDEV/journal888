import { withSupabase } from 'jsr:@supabase/server@^1'

type Claims = Record<string, unknown>

function hasAdminRole(claims: Claims) {
  const appMetadata = (claims.app_metadata && typeof claims.app_metadata === 'object'
    ? claims.app_metadata
    : {}) as Claims
  const roleValues = [
    claims.user_role,
    appMetadata.user_role,
    appMetadata.role,
    ...(Array.isArray(appMetadata.roles) ? appMetadata.roles : []),
  ]
  return roleValues.some((role) => String(role || '').toLowerCase() === 'admin')
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (!hasAdminRole(ctx.jwtClaims as Claims)) {
      return Response.json({ error: 'admin_required' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const page = Math.max(1, Math.floor(Number(body?.page) || 1))
    const perPage = Math.min(100, Math.max(1, Math.floor(Number(body?.perPage) || 50)))
    const { data, error } = await ctx.supabaseAdmin.auth.admin.listUsers({ page, perPage })

    if (error) {
      console.error('list-users failed:', error.message)
      return Response.json({ error: 'unable_to_list_users' }, { status: 500 })
    }

    const users = data.users.map((user) => ({
      id: user.id,
      email: user.email || null,
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at || null,
    }))

    return Response.json({ users, count: users.length, hasMore: users.length === perPage })
  }),
}
