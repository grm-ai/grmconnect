// Redirects to campaigns — the new UI handles all action management via campaigns.
import { useEffect } from 'react'
import { useRouter } from 'next/router'

export default function ActionsRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/campaigns') }, [router])
  return null
}
