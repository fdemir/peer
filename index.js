import 'regenerator-runtime/runtime'
import bridge from './src/bridge'
import signallingServer from './src/signalling'
import sha256 from 'crypto-js/sha256'
import { nodeId, node, sigStore, dataPool} from './src/utils'
import { v4 as uuidv4 } from 'uuid'
import constantEvents from './src/events'

class p2pNetwork extends bridge{
    constructor({bridgeServer, maxNodeCount, maxCandidateCallTime})
    {
        super(bridgeServer)
        this.signallingServers = {}
        this.events = {}
        this.replyChannels = {}
        this.status = 'not-ready'
        this.nodeId = nodeId()
        this.appName = window.location.hostname
        this.nodeAddress = null
        this.maxNodeCount = maxNodeCount
        this.maxCandidateCallTime = maxCandidateCallTime || 900 // 900 = 0.9 second
        this.constantSignallingServer = null

        this.nodeMetaData = {
            name: null,
            description: null
        }

        this.iceServers = [
            {urls:'stun:stun.l.google.com:19302'},
            {urls:'stun:stun4.l.google.com:19302'}
        ];

        this.sigStore = new sigStore(maxNodeCount)

        this.nodes = {}
        
    }

    start()
    {
        this.connectBridge(
            this.listenSignallingServer
        )

        this.loadEvents(constantEvents)
    }

    listenSignallingServer({host}, simulationListener = true)
    {
        if(host === undefined) return false

        const key = sha256(host).toString()
        if(this.existSignallingServer(key)) { // signalling Server is found
            return key
        }
        const signallingServerInstance = new signallingServer(host, ()=> {
            if(this.status === 'not-ready') { // if first signalling server connection
                this.generateNodeAddress(host)
                this.constantSignallingServer = key
            }
            this.upgradeConnection(key)
            this.status = 'ready'
        }, simulationListener ? this.eventSimulation.bind(this) : null)

        const self = this

        signallingServerInstance.loadEvents(constantEvents, self)

        this.signallingServers[key] = signallingServerInstance

        return key
    }

    upgradeConnection(key)
    {
        this.signallingServers[key].signallingSocket.emit('upgrade', this.nodeId)
    }

    existSignallingServer(key)
    {
        return this.signallingServers[key] !== undefined ? true : false
    }

    loadEvents(events)
    {
        events.forEach( ({listener, listenerName}) => {
            this.events[listenerName] = listener.bind(this)
        });
    }

    async pow({transportPackage, livingTime})
    {
        if(this.status !== 'ready') return {warning: this.status}
        const tempListenerName = uuidv4()
        const {question} = this.sigStore.generate(this.maxCandidateCallTime)

        let powOffersPool = []

        this.temporaryBridgelistener(tempListenerName, (node)=> {powOffersPool.push(node)})

        this.transportMessage({
            ...transportPackage,
            nodeId: this.nodeId,
            temporaryListener: tempListenerName,
            livingTime: livingTime,
            nodeAddress: this.nodeAddress,
            powQuestion: question
        })

        await this.sleep(livingTime) // wait pool

        if(powOffersPool.length <= 0) return false

        const pool = new dataPool()

        const poollingListenerName = uuidv4()
        this.events[poollingListenerName] = (data) => {
            pool.listen(data)
        }

        transportPackage = {
            ...transportPackage,
            reply: {
                listener: poollingListenerName,
                nodeId: this.nodeId
            }
        }        


        for(let nodeId in powOffersPool){
            const node = powOffersPool[nodeId] || false
            node.send(transportPackage)
        }

        await this.sleep(800)

        return pool.export()

    }

    temporaryBridgelistener(tempListenerName, callback)
    {
        this.bridgeSocket.on(tempListenerName, ({nodeAddress, powQuestionAnswer}) => { // listen transport event result
            
            if(!this.sigStore.isvalid(powQuestionAnswer)){
                return false
            }

            const {nodeId, signallingServerAddress} = this.parseNodeAddress(nodeAddress)
            const signallHash = this.listenSignallingServer({host: signallingServerAddress}, false)
            const targetNode = this.createNode(signallHash, nodeId)
            targetNode.createOffer(powQuestionAnswer.answer, signallHash)
            callback(targetNode)
        })
    }

    async sleep(ms)
    {
        return new Promise((resolve)=> {
            setTimeout(()=> {
                resolve(true)
            }, ms)
        })
    }

    async eventSimulation(eventObject)
    {
        const {eventPackage, powQuestion} = eventObject
        const {nodeId, p2pChannelName} = eventPackage

        if(nodeId === this.nodeId) return false

        if(this.findNode(nodeId)) return false // node currently connected.

        const listener = this.findNodeEvent(p2pChannelName) // find p2p event listener

        if(!listener) return false

        const simulateProcess = await listener(eventPackage, true)

        if(!simulateProcess) return false

        const powQuestionAnswer = this.sigStore.solveQuestion(powQuestion)
        if(!powQuestionAnswer) return false

        await this.sendSimulationDoneSignall(powQuestionAnswer, eventObject)
    }

    async sendSimulationDoneSignall(powQuestionAnswer, eventObject)
    {
        const {bridgePoolingListener} = eventObject
        
        this.bridgeSocket.emit('transport-pooling', {
            bridgePoolingListener: bridgePoolingListener,
            nodeAddress: this.nodeAddress,
            powQuestionAnswer: powQuestionAnswer
        })
    }

    findNodeEvent(listenerName)
    {
        return this.events[listenerName] || false
    }

    findNode(nodeId)
    {
        return this.nodes[nodeId] ? true : false
    }

    generateNodeAddress(signallingHostAddress)
    {
        const {protocol, hostname, port = 80} = new URL(signallingHostAddress)
        this.nodeAddress = `${this.nodeId}&${protocol.slice(0, -1)}&${hostname}&${port}`
    }

    parseNodeAddress(nodeAddress)
    {
        const [nodeId, protocol, host, port] = nodeAddress.split('&')
        
        const signallingServerAddress = `${protocol}://${host}:${port}`

        return {
            nodeId,
            signallingServerAddress
        }

    }

    reply({nodeId, listener}, data)
    {
        const targetNode = this.nodes[nodeId] || false
        if(!targetNode) return false

        targetNode.send({
            p2pChannelName: listener,
            data: data,
            nodeId: this.nodeId
        })

        return true
    }

    createNode(signallHash, nodeId)
    {
        const candidateNode = new node(
            this.iceServers, 
            this.signallingServers[signallHash],
            this
        )

        candidateNode.create(nodeId)

        this.nodes[nodeId] = candidateNode

        return candidateNode
    }

    setMetaData({name, description})
    {
        this.nodeMetaData = {
            name: name,
            description: description
        }
    }
}


export default p2pNetwork
