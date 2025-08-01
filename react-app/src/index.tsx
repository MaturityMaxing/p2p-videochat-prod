// polyfill for older browsers such as safari on outdate ios
import 'react-app-polyfill/ie11'
import 'react-app-polyfill/stable'
import 'adapterjs'
import 'webrtc-adapter'

import { configure, makeAutoObservable } from 'mobx'
import { observer } from 'mobx-react-lite'
import pokemon from 'pokemon'
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { toast, ToastContainer } from 'react-toastify'
import { io, Socket } from 'socket.io-client'

import './index.scss'
import './Dashboard.scss'

import type { ClientToServerEvents, ServerToClientEvents } from '../../server'
import noise from './assets/noise.mp3'
import { supabase, type DatabaseUser } from './supabase'
import Landing from './Landing'
import SignInModal from './SignInModal'

configure({ enforceActions: 'never' })

// declare typescript polyfill for older browser such as safari on outdate ios
declare global {
  interface RTCStreamEvent {
    stream: MediaStream
  }
  interface RTCPeerConnection {
    addStream?: (stream: MediaStream) => void
    onaddstream?: (e: RTCStreamEvent) => void
  }
}

/** ----------------------------------------------------------------------------
 * data that affect the UI we put it in state
 */

class State {
  constructor() {
    makeAutoObservable(this)
  }
  status:
    | 'idle'
    | 'webcam-loading'
    | 'webcam-error'
    | 'ws-loading'
    | 'ready-to-queue'
    | 'in-queue'
    | 'webrtc-loading'
    | 'success' = 'idle'
  localName = pokemon.random()
  localStream?: MediaStream
  remoteName = ''
  remoteStream?: MediaStream
  currentUser: DatabaseUser | null = null
}
const state = new State()

const cleanupLocal = (keepName?: boolean) => {
  if (!keepName) {
    state.localName = pokemon.random()
  }
  if (cleanupWebcamListeners) {
    cleanupWebcamListeners()
    cleanupWebcamListeners = undefined
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop())
    state.localStream = undefined
  }
}
const cleanupRemote = () => {
  state.remoteName = ''
  if (state.remoteStream) {
    state.remoteStream.getTracks().forEach(t => t.stop())
    state.remoteStream = undefined
  }
}

/** ----------------------------------------------------------------------------
 * data that not affect the UI, we declare as static variables here
 */
type MySocket = Socket<ServerToClientEvents, ClientToServerEvents>

let ws: MySocket | undefined = undefined
const cleanupWs = () => {
  if (!ws) {
    return
  }
  ws.removeAllListeners()
  ws.disconnect()
  ws = undefined
}

let peer: RTCPeerConnection | undefined = undefined
const cleanupPeer = () => {
  if (!peer) {
    return
  }
  peer.onicecandidate = null
  peer.onicecandidateerror = null
  peer.ontrack = null
  peer.close()
  peer = undefined
}

/** ----------------------------------------------------------------------------
 * event handlers and logic
 */

let cleanupWebcamListeners: Function | undefined = undefined

const openWebcam = () => {
  console.log('openWebcam')
  state.status = 'webcam-loading'
  playPermissionOnUserInteract()
  navigator.mediaDevices
    .getUserMedia({ audio: true, video: true })
    .then(stream => {
      state.localStream = stream
      startWs()
      const tracks = stream.getTracks()
      const onTrackEnd = () => {
        if (state.status === 'idle') {
          return
        }
        reset(true)
        toast.error('Webcam stopped')
      }
      tracks.forEach(t => t.addEventListener('ended', onTrackEnd))
      cleanupWebcamListeners?.()
      cleanupWebcamListeners = () => {
        tracks.forEach(t => t.removeEventListener('ended', onTrackEnd))
      }
    })
    .catch((err: Error) => {
      state.status = 'webcam-error'
      const msg = err?.message || `${err}`
      toast.error(`Failed to access webcam. Debug: ${msg}`)
    })
}
// to get audio video play permission over browser policy strict on user interaction
// this could solve some case with black remote video if the user has a long time not interact?
const playPermissionOnUserInteract = () => {
  const v = document.createElement('video')
  v.classList.add('invisible')
  v.loop = true
  v.playsInline = true
  v.volume = 0.01
  v.src = noise
  document.body.appendChild(v)
  v.play()?.catch((err: Error) => {
    const msg = err?.message || `${err}`
    toast.error(`Debug: ${msg}`)
  })
  setTimeout(() => document.body.removeChild(v), 1000)
}

const startWs = (rejoinQueue?: boolean) => {
  console.log('startWs')
  cleanupWs()
  state.status = 'ws-loading'
  ws = process.env.NODE_ENV === 'production' ? io() : io('localhost:4000')
  
  // Determine user type and name from global state
  const user = state.currentUser
  const userType = user ? user.user_role : 'non-member'
  const displayName = user ? user.email : state.localName // Email for logged in, Pokemon for non-members
  
  ws.emit('setInfo', {
    name: displayName,
    userType: userType,
    email: user?.email
  })
  ws.on('setInfoSuccess', d => {
    if (d.serverSocketId !== ws?.id) {
      console.error(
        'server socket id not same with client socket id, this should not happen',
      )
    }
    if (!rejoinQueue) {
      state.status = 'ready-to-queue'
    } else {
      joinQueue()
    }
  })
  ws.on('match', onWsMatch)
  ws.on('offer', onWsOffer)
  ws.on('answer', onWsAnswer)
  ws.on('icecandidate', onWsIceCandidate)
  ws.on('leave', onWsLeave)
  ws.on('disconnect', reason => {
    // automatically reconnect if webcam is running
    const isWebcamRunning = cleanupWebcamListeners
    const msg = isWebcamRunning ? 'Reconnecting...' : 'Network error.'
    toast.error(`${msg} Debug: ${reason}`)
    if (!isWebcamRunning) {
      reset(true)
      return
    }
    // automatically reconnect if webcam is running
    const _rejoinQueue =
      state.status === 'in-queue' ||
      state.status === 'webrtc-loading' ||
      state.status === 'success'
    cleanupPeer()
    cleanupRemote()
    startWs(_rejoinQueue)
  })
}
const onWsMatch = (d: {
  roomId: string
  remoteName: string
  createOffer?: boolean
}) => {
  console.log('onWsMatch')
  state.remoteName = d.remoteName
  state.status = 'webrtc-loading'
  toast.success(`Matched with ${d.remoteName}`)
  if (!d.createOffer) {
    return
  }
  createPeerConnection()
}
const onWsOffer = (sdp: RTCSessionDescriptionInit) => {
  console.log('onWsOffer')
  createPeerConnection(sdp)
}
const onWsAnswer = (sdp: RTCSessionDescriptionInit) => {
  console.log('onWsAnswer')
  peer?.setRemoteDescription(new RTCSessionDescription(sdp))
}
const onWsIceCandidate = (candidate: RTCIceCandidate | null) => {
  console.log('onWsIceCandidate')
  if (candidate) {
    peer?.addIceCandidate(new RTCIceCandidate(candidate))
    return
  }
  try {
    // IE compatible
    var ua = window.navigator.userAgent
    if (ua.indexOf('Edge') > -1 || /edg/i.test(ua)) {
      peer?.addIceCandidate(null as any)
    }
  } catch (err) {}
}
const onWsLeave = (d: { remoteId: string; isTimeout?: boolean }) => {
  console.log('onWsLeave')
  if (d.remoteId === ws?.id) {
    return
  }
  const reason = d.isTimeout ? 'disconnected' : 'left'
  toast.info(`${state.remoteName} ${reason}`)
  // this handler will be called whenever if the other participant left
  // we also need to emit to the server to leave the current room and back to queue
  ws?.emit('leave')
  state.status = 'in-queue'
  cleanupPeer()
  cleanupRemote()
}

const createPeerConnection = async (offerSdp?: RTCSessionDescriptionInit) => {
  console.log('createPeerConnection')
  cleanupPeer()
  peer = new RTCPeerConnection({
    iceServers: [
      {
        urls: ['stun:stun.l.google.com:19302'],
      },
      {
        urls: ['turn:128.199.120.243:3478', 'turn:128.199.120.243:3479'],
        username: 'turnuser',
        credential: 'turnpass',
      },
    ],
  })
  peer.onicecandidate = onPeerIceCandidate
  if (peer.addStream) {
    peer.onaddstream = onPeerStream
    if (state.localStream) {
      peer.addStream(state.localStream)
    }
  } else {
    peer.ontrack = onPeerTrack
    state.localStream?.getTracks().forEach(t => peer?.addTrack(t))
  }
  if (!offerSdp) {
    const localSdp = await peer.createOffer()
    peer.setLocalDescription(localSdp)
    ws?.emit('offer', localSdp)
    return
  }
  peer.setRemoteDescription(new RTCSessionDescription(offerSdp))
  const localSdp = await peer.createAnswer()
  peer.setLocalDescription(localSdp)
  ws?.emit('answer', localSdp)
}
const onPeerIceCandidate = (e: RTCPeerConnectionIceEvent) => {
  console.log('onPeerIceCandidate')
  ws?.emit('icecandidate', e.candidate)
}
const onPeerStream = (e: RTCStreamEvent) => {
  console.log('onPeerStream')
  state.remoteStream = e.stream
  state.status = 'success'
}
const onPeerTrack = (e: RTCTrackEvent) => {
  console.log('onPeerTrack')
  if (!state.remoteStream) {
    state.remoteStream = new MediaStream()
  }
  state.remoteStream.addTrack(e.track)
  state.status = 'success'
}

const joinQueue = () => {
  console.log('joinQueue')
  ws?.emit('queue')
  state.status = 'in-queue'
}
const leaveQueue = () => {
  console.log('leaveQueue')
  ws?.emit('unqueue')
  state.status = 'ready-to-queue'
}
const next = () => {
  console.log('next')
  cleanupPeer()
  cleanupRemote()
  ws?.emit('leave')
  state.status = 'in-queue'
}
const forget = () => {
  console.log('forget')
  ws?.emit('forget')
  toast.info('Removed skip/next cache')
}

const reset = (keepName?: boolean) => {
  console.log('reset')
  cleanupWs()
  cleanupPeer()
  cleanupLocal(keepName)
  cleanupRemote()
  state.status = 'idle'
}



interface DashboardProps {
  user: DatabaseUser | null
  onBackToLanding: () => void
}

export const Dashboard = observer(({ user, onBackToLanding }: DashboardProps) => {
  // Set current user in global state for use by websocket functions
  state.currentUser = user
  
  const { status, localName, localStream, remoteName, remoteStream } = state
  const [memberCTAClicked, setMemberCTAClicked] = useState(false)
  
  // Determine display name: email for logged-in users, Pokemon for non-members
  const displayName = user ? user.email : localName
  
  // Sign out function
  const handleSignOut = async () => {
    console.log('🔍 [LOGOUT DEBUG] ===== DASHBOARD LOGOUT CLICKED =====')
    console.log('🔍 [LOGOUT DEBUG] Current user state before logout:', user)
    
    // Check if session exists first
    const { data: { session } } = await supabase.auth.getSession()
    console.log('🔍 [LOGOUT DEBUG] Current session before logout:', session)
    
    if (session) {
      try {
        console.log('🔍 [LOGOUT DEBUG] Session exists, calling signOut()...')
        const result = await supabase.auth.signOut()
        console.log('🔍 [LOGOUT DEBUG] signOut() result:', result)
        
        if (result.error) {
          console.error('🔍 [LOGOUT DEBUG] signOut() error:', result.error)
          // If signOut fails, manually navigate to landing and clear state
          console.log('🔍 [LOGOUT DEBUG] Manually navigating to landing due to signOut error')
          onBackToLanding()
        } else {
          console.log('🔍 [LOGOUT DEBUG] signOut() successful, should trigger auth state change')
        }
      } catch (error) {
        console.error('🔍 [LOGOUT DEBUG] signOut() exception:', error)
        // If signOut fails, manually navigate to landing
        console.log('🔍 [LOGOUT DEBUG] Manually navigating to landing due to exception')
        onBackToLanding()
      }
    } else {
      console.log('🔍 [LOGOUT DEBUG] No session found, manually navigating to landing')
      // No session exists, just navigate to landing (state will be cleared by landing page load)
      onBackToLanding()
    }
    
    console.log('🔍 [LOGOUT DEBUG] ===== DASHBOARD LOGOUT COMPLETE =====')
  }
  
  // Back to landing function
  const handleBackToLanding = () => {
    console.log('🔍 [AUTH DEBUG] Back to landing clicked')
    onBackToLanding()
  }
  
  // Member CTA handler
  const handleMemberCTA = () => {
    console.log('🔍 [MEMBER] Start Mature Maxing clicked')
    setMemberCTAClicked(true)
    // TODO: Implement Stripe/crypto payment flow
  }
  return (
    <>
      <ToastContainer newestOnTop pauseOnFocusLoss={false} />
      
      {/* CRITICAL: Keep video containers exactly as they are */}
      <div className='local'>
        {localStream && <Video muted stream={localStream} />}
        <div className='dashboard-overlay'>
          {(status === 'idle' || status === 'webcam-error') && (
            <div className='action button' onClick={openWebcam}>
              Open Webcam
            </div>
          )}
          {status === 'ready-to-queue' && (
            <div className='action button' onClick={joinQueue}>
              Join Queue
            </div>
          )}
          {status === 'in-queue' && (
            <div className='action button' onClick={leaveQueue}>
              Leave Queue
            </div>
          )}
          {status === 'webrtc-loading' ||
            (status === 'success' && (
              <div className='action button' onClick={next}>
                Next
              </div>
            ))}
          <div className='back-to-landing button' onClick={handleBackToLanding}>
            ← Landing
          </div>
          <div className='status button' onClick={forget}>
            {status}
          </div>
        </div>
      </div>
      
      <div className='remote'>
        {remoteStream && <Video stream={remoteStream} />}
        <div className='dashboard-overlay'>
          {status === 'in-queue' ? (
            <div className='status button'>Waiting for participant...</div>
          ) : remoteName ? (
            <div className='status button'>
              {remoteName}
              {status !== 'success' ? ' | Connecting...' : ''}
            </div>
          ) : null}
        </div>
        
        {/* Member CTA - positioned in bottom right of beige section */}
        {!user && (
          <div className='member-overlay'>
            <button className='member-cta' onClick={handleMemberCTA}>
              {memberCTAClicked ? 'Coming soon' : 'Start Mature Maxing'}
            </button>
          </div>
        )}
      </div>
      
      <div className='dashboard-overlay'>
        <div className='version button'>MaturityMaxing v1.0.0</div>
      </div>
    </>
  )
})

const Video = (p: { stream: MediaStream; muted?: boolean }) => {
  const r = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const v = r.current
    if (!p.stream || !v) {
      return
    }
    v.loop = true
    v.playsInline = true
    v.srcObject = p.stream
    v.play()?.catch((err: Error) => {
      const msg = err?.message || `${err}`
      toast.error(`Debug: ${msg}`)
    })
  }, [p.stream])
  return <video ref={r} loop playsInline controls={false} muted={p.muted} />
}

// Auth wrapper component
const App = observer(() => {
  const [currentView, setCurrentView] = useState<'landing' | 'dashboard'>('landing')
  const [isSignInModalOpen, setIsSignInModalOpen] = useState(false)
  const [user, setUser] = useState<DatabaseUser | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  useEffect(() => {
    let isInitialLoad = true
    
    // Check initial auth state
    const checkAuth = async () => {
      console.log('🔍 [AUTH DEBUG] Starting checkAuth process...')
      try {
        console.log('🔍 [AUTH DEBUG] Getting session...')
        const { data: { session }, error: sessionError } = await supabase.auth.getSession()
        
        console.log('🔍 [AUTH DEBUG] Session result:', { 
          hasSession: !!session, 
          userEmail: session?.user?.email,
          sessionError 
        })
        
        if (sessionError) {
          console.error('🔍 [AUTH DEBUG] Session error:', sessionError)
        }
        
        if (session?.user?.email) {
          console.log('🔍 [AUTH DEBUG] Session found, querying database for user:', session.user.email)
          
          // Fetch user data from our database
          const { data: userData, error: dbError } = await supabase
            .from('users')
            .select('*')
            .eq('email', session.user.email)
            .single()
          
          console.log('🔍 [AUTH DEBUG] Database query result:', { 
            hasUserData: !!userData, 
            userData,
            dbError 
          })
          
          if (dbError) {
            console.error('🔍 [AUTH DEBUG] Database error:', dbError)
          }
          
          if (userData) {
            console.log('🔍 [AUTH DEBUG] Setting user data and switching to dashboard')
            setUser(userData)
            setCurrentView('dashboard')
          } else {
            console.log('🔍 [AUTH DEBUG] No user data found in database')
          }
        } else {
          console.log('🔍 [AUTH DEBUG] No session or email found')
        }
      } catch (error) {
        console.error('🔍 [AUTH DEBUG] Catch block error:', error)
      } finally {
        console.log('🔍 [AUTH DEBUG] Setting authLoading to false')
        setAuthLoading(false)
        isInitialLoad = false
      }
    }

    checkAuth()

    // Listen for auth changes (but skip during initial load to prevent interference)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log('🔍 [AUTH DEBUG] ===== AUTH STATE CHANGE FIRED =====')
      console.log('🔍 [AUTH DEBUG] Event:', event)
      console.log('🔍 [AUTH DEBUG] Has session:', !!session)
      console.log('🔍 [AUTH DEBUG] User email:', session?.user?.email)
      console.log('🔍 [AUTH DEBUG] Is initial load:', isInitialLoad)
      console.log('🔍 [AUTH DEBUG] Current user state:', user)
      console.log('🔍 [AUTH DEBUG] Current view state:', currentView)
      
      // Skip auth state changes during initial load to prevent interference
      if (isInitialLoad) {
        console.log('🔍 [AUTH DEBUG] Skipping auth state change during initial load')
        return
      }
      
      if (event === 'SIGNED_IN' && session?.user?.email) {
        console.log('🔍 [AUTH DEBUG] Processing SIGNED_IN event')
        const { data: userData, error: dbError } = await supabase
          .from('users')
          .select('*')
          .eq('email', session.user.email)
          .single()
        
        console.log('🔍 [AUTH DEBUG] Auth change DB query result:', { userData, dbError })
        
        if (userData) {
          console.log('🔍 [AUTH DEBUG] Setting user and switching to dashboard from auth change')
          setUser(userData)
          setCurrentView('dashboard')
        }
      } else if (event === 'SIGNED_OUT') {
        console.log('🔍 [LOGOUT DEBUG] ===== PROCESSING SIGNED_OUT EVENT =====')
        console.log('🔍 [LOGOUT DEBUG] About to clear user state and go to landing')
        setUser(null)
        setCurrentView('landing')
        console.log('🔍 [LOGOUT DEBUG] State updates called - user cleared, view set to landing')
        console.log('🔍 [LOGOUT DEBUG] ===== SIGNED_OUT EVENT PROCESSING COMPLETE =====')
      }
      
      console.log('🔍 [AUTH DEBUG] ===== AUTH STATE CHANGE COMPLETE =====')
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleStartMaturing = () => {
    console.log('🔍 [AUTH DEBUG] handleStartMaturing clicked, switching to dashboard')
    setCurrentView('dashboard')
  }
  
  const handleBackToLanding = () => {
    console.log('🔍 [AUTH DEBUG] Back to landing from dashboard')
    setCurrentView('landing')
  }

  const handleSignIn = () => {
    setIsSignInModalOpen(true)
  }

  const handleSignInSuccess = () => {
    setIsSignInModalOpen(false)
    // User state will be updated by the auth state change listener
  }
  
  const handleSignOutFromLanding = async () => {
    console.log('🔍 [LOGOUT DEBUG] ===== LANDING LOGOUT CLICKED =====')
    console.log('🔍 [LOGOUT DEBUG] Current user state before logout:', user)
    
    // Check if session exists first
    const { data: { session } } = await supabase.auth.getSession()
    console.log('🔍 [LOGOUT DEBUG] Current session before logout:', session)
    
    if (session) {
      try {
        console.log('🔍 [LOGOUT DEBUG] Session exists, calling signOut()...')
        const result = await supabase.auth.signOut()
        console.log('🔍 [LOGOUT DEBUG] signOut() result:', result)
        
        if (result.error) {
          console.error('🔍 [LOGOUT DEBUG] signOut() error:', result.error)
          // If signOut fails, manually clear state
          console.log('🔍 [LOGOUT DEBUG] Manually clearing state due to signOut error')
          setUser(null)
          setCurrentView('landing')
        }
      } catch (error) {
        console.error('🔍 [LOGOUT DEBUG] signOut() exception:', error)
        // If signOut fails, manually clear state
        console.log('🔍 [LOGOUT DEBUG] Manually clearing state due to exception')
        setUser(null)
        setCurrentView('landing')
      }
    } else {
      console.log('🔍 [LOGOUT DEBUG] No session found, manually clearing React state')
      // No session exists, just clear our React state
      setUser(null)
      setCurrentView('landing')
    }
    
    console.log('🔍 [LOGOUT DEBUG] ===== LANDING LOGOUT COMPLETE =====')
  }

  console.log('🔍 [AUTH DEBUG] Render state:', { 
    authLoading, 
    currentView, 
    hasUser: !!user,
    userEmail: user?.email 
  })
  
  if (authLoading) {
    console.log('🔍 [AUTH DEBUG] Showing loading screen')
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh', 
        fontSize: '1.5rem',
        fontWeight: 'bold'
      }}>
        Loading...
      </div>
    )
  }

  return (
    <>
      {currentView === 'landing' ? (
        <Landing 
          onStartMaturing={handleStartMaturing}
          onSignIn={handleSignIn}
          onSignOut={handleSignOutFromLanding}
          user={user}
        />
      ) : (
        <Dashboard user={user} onBackToLanding={handleBackToLanding} />
      )}
      
      <SignInModal
        isOpen={isSignInModalOpen}
        onClose={() => setIsSignInModalOpen(false)}
        onSignInSuccess={handleSignInSuccess}
      />
    </>
  )
})

const div = document.getElementById('root') as HTMLDivElement
createRoot(div).render(<App />)
